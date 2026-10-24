import { priceToMinorUnits } from '../agents/quotationSchemas.js';
import type { UploadTaskBinding } from './taskBindings.js';
import type { QuotationUploadStore, UploadQuotation } from './quotationUploads.js';

export const PREFLIGHT_VERSION = 'document-preflight-v1';
export type PreflightDecision = 'ALLOW' | 'REVIEW' | 'BLOCK';
export type PreflightFinding = Readonly<{
  category: 'prompt_injection' | 'data_anomaly' | 'sensitive_data' | 'provenance';
  severity: 'info' | 'medium' | 'high' | 'critical';
  ruleId: string; explanation: string; location: string;
  resultStatus: 'suspicious' | 'inconsistent' | 'detected' | 'unverified';
  recommendedHandling: 'allow_filtered' | 'operator_review' | 'block_disclosure';
}>;
export type DocumentAssessment = Readonly<{
  taskId: string; sessionId: string; documentId: string; alias: 'quote-A' | 'quote-B';
  inspectionVersion: typeof PREFLIGHT_VERSION; assessedAt: string;
  sourceSha256: string; normalizedSha256: string; decision: PreflightDecision;
  findings: readonly PreflightFinding[];
}>;
export type TaskDisclosure = Readonly<{ taskId: string; decision: PreflightDecision; inspectionVersion: typeof PREFLIGHT_VERSION; documents: readonly DocumentAssessment[]; modelFields: readonly string[] }>;

type Input = Awaited<ReturnType<QuotationUploadStore['inspectionInput']>>;
type Rule = Readonly<{id:string; category:PreflightFinding['category']; severity:PreflightFinding['severity']; status:PreflightFinding['resultStatus']; handling:PreflightFinding['recommendedHandling']; explanation:string; pattern:RegExp}>;
const rules: readonly Rule[] = [
  {id:'DP-I001',category:'prompt_injection',severity:'high',status:'suspicious',handling:'operator_review',explanation:'Role or system-message spoofing indicator.',pattern:/(?:\[\s*im_start\s*\]|<\s*\/?\s*(?:system|developer)\s*>|(?:^|\n)\s*(?:system|developer)\s*:\s*(?:ignore|override|new instructions))/i},
  {id:'DP-I002',category:'prompt_injection',severity:'high',status:'suspicious',handling:'operator_review',explanation:'Instruction override indicator.',pattern:/\b(?:ignore|disregard|override)\b.{0,80}\b(?:previous|prior|system|developer|instructions|rules)\b/i},
  {id:'DP-I003',category:'prompt_injection',severity:'high',status:'suspicious',handling:'operator_review',explanation:'Grant or policy manipulation indicator.',pattern:/\b(?:change|expand|bypass|disable|override|grant|approve)\b.{0,80}\b(?:grant|policy|approval|permission|authorization)\b/i},
  {id:'DP-I004',category:'prompt_injection',severity:'critical',status:'suspicious',handling:'block_disclosure',explanation:'Outbound exfiltration or unauthorized email instruction.',pattern:/\b(?:send|email|forward|post|upload|exfiltrate)\b.{0,100}\b(?:secret|credential|token|api.?key|private|all documents|outside|external|unauthorized)\b/i},
  {id:'DP-I005',category:'prompt_injection',severity:'high',status:'suspicious',handling:'operator_review',explanation:'Tool, deletion or credential-exposure instruction.',pattern:/\b(?:call|invoke|run|execute|delete|remove|reveal|print)\b.{0,80}\b(?:tool|delete_quote|file|credential|token|api.?key|password)\b/i},
  {id:'DP-I006',category:'prompt_injection',severity:'medium',status:'suspicious',handling:'operator_review',explanation:'Encoded instruction indicator; payload was not decoded or trusted.',pattern:/\b(?:base64|rot13|decode this|hex-encoded)\b.{0,100}\b(?:instruction|prompt|system|email|tool|policy)\b/i},
  {id:'DP-S001',category:'sensitive_data',severity:'medium',status:'detected',handling:'operator_review',explanation:'Email address detected.',pattern:/\b[A-Z0-9._%+-]{1,64}@[A-Z0-9.-]{1,100}\.[A-Z]{2,20}\b/i},
  {id:'DP-S002',category:'sensitive_data',severity:'medium',status:'detected',handling:'operator_review',explanation:'Phone-number indicator detected.',pattern:/(?:\+\d{1,3}[ -]?)?(?:\(\d{2,4}\)|\d{3,5})[ -]?\d{3,5}[ -]?\d{4}\b/},
  {id:'DP-S003',category:'sensitive_data',severity:'critical',status:'detected',handling:'block_disclosure',explanation:'Credential or token-like value detected.',pattern:/\b(?:api[_ -]?key|access[_ -]?token|secret|password|credential)\s*[:=]\s*[A-Za-z0-9_./+\-=]{8,}/i},
  {id:'DP-S004',category:'sensitive_data',severity:'high',status:'detected',handling:'operator_review',explanation:'Financial-account identifier indicator.',pattern:/\b(?:bank|account|iban|routing|swift)\s*(?:number|no\.?|id)?\s*[:=]\s*[A-Z0-9 -]{8,34}/i},
  {id:'DP-S005',category:'sensitive_data',severity:'medium',status:'detected',handling:'operator_review',explanation:'Personal or private-business identifier indicator.',pattern:/\b(?:passport|aadhaar|social security|employee id|confidential internal|private business)\b/i}
];
const finding = (rule: Omit<PreflightFinding,'location'>, location: string): PreflightFinding => Object.freeze({...rule,location});
function inspect(input:Input, bound:UploadTaskBinding, alias:'quote-A'|'quote-B'): DocumentAssessment {
  const document=bound.aliases[alias], findings:PreflightFinding[]=[];
  const add=(rule:Omit<PreflightFinding,'location'>,where:string)=>findings.push(finding(rule,where));
  if(input.content.length>64_000) add({category:'data_anomaly',severity:'critical',ruleId:'DP-D001',explanation:'Document exceeds bounded inspection limit.',resultStatus:'inconsistent',recommendedHandling:'block_disclosure'},'document');
  if(input.originalSha256!==input.computedOriginalSha256||input.originalSha256!==document.originalSha256||input.normalizedSha256!==input.computedNormalizedSha256||input.normalizedSha256!==document.normalizedSha256) add({category:'data_anomaly',severity:'critical',ruleId:'DP-D002',explanation:'Source or confirmed-record integrity check failed.',resultStatus:'inconsistent',recommendedHandling:'block_disclosure'},'integrity');
  if(input.content.length<=64_000){
    // Match only bounded, locally held text. Never copy match values into findings.
    for(const rule of rules) if(rule.pattern.test(input.content)) add({category:rule.category,severity:rule.severity,ruleId:rule.id,explanation:rule.explanation,resultStatus:rule.status,recommendedHandling:rule.handling},'source text [redacted]');
    for(const [field,value] of Object.entries(input.quotation)) if(typeof value==='string'){
      for(const rule of rules) if(rule.pattern.test(value)) add({category:rule.category,severity:rule.severity,ruleId:rule.id,explanation:rule.explanation,resultStatus:rule.status,recommendedHandling:rule.handling},`${field} [redacted]`);
    }
    let source:unknown;
    try{source=JSON.parse(input.content);}catch{/* TXT sources may not be JSON. */}
    if(source&&typeof source==='object'&&!Array.isArray(source)){
      const raw=source as Record<string,unknown>;
      for(const key of ['supplier','item','quantity','quantityUnit','unitPrice','currency','leadTimeDays','paymentTerms']){
        if(raw[key]===undefined) add({category:'data_anomaly',severity:'medium',ruleId:'DP-D003',explanation:'Required source field is absent or nested; confirmation requires review.',resultStatus:'inconsistent',recommendedHandling:'operator_review'},key);
        else if(String(raw[key])!==String(input.quotation[key as keyof UploadQuotation])) add({category:'data_anomaly',severity:'medium',ruleId:'DP-D004',explanation:'Confirmed field differs from the source extraction.',resultStatus:'inconsistent',recommendedHandling:'operator_review'},key);
      }
      if(raw.total!==undefined){
        const actual=typeof raw.total==='number'||typeof raw.total==='string'?raw.total:undefined;
        try{if(actual===undefined||BigInt(priceToMinorUnits(actual))!==BigInt(input.quotation.quantity)*BigInt(priceToMinorUnits(input.quotation.unitPrice)))throw new Error();}
        catch{add({category:'data_anomaly',severity:'high',ruleId:'DP-D005',explanation:'Stated total differs from quantity times unit price.',resultStatus:'inconsistent',recommendedHandling:'operator_review'},'total');}
      }
      if(raw.totalCurrency!==undefined&&raw.totalCurrency!==input.quotation.currency) add({category:'data_anomaly',severity:'medium',ruleId:'DP-D006',explanation:'Currency fields conflict.',resultStatus:'inconsistent',recommendedHandling:'operator_review'},'totalCurrency');
    }
    const duplicates=[...input.content.matchAll(/"(supplier|item|quantity|quantityUnit|unitPrice|currency|leadTimeDays|paymentTerms)"\s*:/g)].map(match=>match[1]);
    if(new Set(duplicates).size<duplicates.length) add({category:'data_anomaly',severity:'high',ruleId:'DP-D007',explanation:'Duplicate structured field keys detected.',resultStatus:'inconsistent',recommendedHandling:'operator_review'},'structured fields');
  }
  add({category:'provenance',severity:'info',ruleId:'DP-P001',explanation:'No independent supplier-origin verification is available; authenticity is unknown.',resultStatus:'unverified',recommendedHandling:'allow_filtered'},'origin');
  const decision:PreflightDecision=findings.some(x=>x.recommendedHandling==='block_disclosure')?'BLOCK':findings.some(x=>x.recommendedHandling==='operator_review')?'REVIEW':'ALLOW';
  return Object.freeze({taskId:bound.taskId,sessionId:bound.sessionId,documentId:document.documentId,alias,inspectionVersion:PREFLIGHT_VERSION,assessedAt:new Date().toISOString(),sourceSha256:document.originalSha256,normalizedSha256:document.normalizedSha256,decision,findings:Object.freeze(findings)});
}
export class DocumentPreflight {
  private readonly byTask=new Map<string,TaskDisclosure>();
  async assess(store:QuotationUploadStore,binding:UploadTaskBinding,capability:string):Promise<TaskDisclosure>{
    this.byTask.delete(binding.taskId);
    const documents:DocumentAssessment[]=[];
    for(const alias of ['quote-A','quote-B'] as const){
      const input=await store.inspectionInput(binding.sessionId,capability,binding.aliases[alias].documentId);
      documents.push(inspect(input,binding,alias));
    }
    const decision:PreflightDecision=documents.some(x=>x.decision==='BLOCK')?'BLOCK':documents.some(x=>x.decision==='REVIEW')?'REVIEW':'ALLOW';
    const result=Object.freeze({taskId:binding.taskId,decision,inspectionVersion:PREFLIGHT_VERSION,documents:Object.freeze(documents),modelFields:Object.freeze(['fileId','supplier','item','quantity','quantityUnit','unitPrice','currency','leadTimeDays','paymentTerms'])});
    this.byTask.set(binding.taskId,result);return result;
  }
  get(taskId:string):TaskDisclosure|undefined {return this.byTask.get(taskId);}
  async canDisclose(store:QuotationUploadStore,binding:UploadTaskBinding,capability:string):Promise<boolean>{
    const record=this.byTask.get(binding.taskId);
    if(!record||record.decision!=='ALLOW'||record.documents.length!==2||!store.isAlive(binding.sessionId))return false;
    try{for(const assessment of record.documents){
      if(assessment.taskId!==binding.taskId||assessment.sessionId!==binding.sessionId||assessment.inspectionVersion!==PREFLIGHT_VERSION||binding.aliases[assessment.alias].documentId!==assessment.documentId)return false;
      const current=await store.inspectionInput(binding.sessionId,capability,assessment.documentId);
      if(current.originalSha256!==assessment.sourceSha256||current.computedOriginalSha256!==assessment.sourceSha256||current.normalizedSha256!==assessment.normalizedSha256||current.computedNormalizedSha256!==assessment.normalizedSha256)return false;
    }}catch{return false;}
    return true;
  }
}
