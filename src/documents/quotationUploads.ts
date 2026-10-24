import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { z } from 'zod';
import { priceToMinorUnits } from '../agents/quotationSchemas.js';

const MAX_BYTES = 2 * 1024 * 1024;
const value = z.string().trim().min(1).max(500);
export const correctionSchema = z.object({ supplier:value.max(120), item:value.max(160), quantity:z.number().int().positive().max(1_000_000), quantityUnit:z.enum(['each','kg']), unitPrice:z.union([z.number(),z.string()]), currency:z.enum(['INR','USD','EUR','GBP']), leadTimeDays:z.number().int().min(0).max(3650), paymentTerms:value, documentText:z.string().max(8000).optional() }).strict().superRefine((x,c)=>{try{priceToMinorUnits(x.unitPrice)}catch{c.addIssue({code:z.ZodIssueCode.custom,message:'Invalid unit price'})}});
export type UploadQuotation = z.infer<typeof correctionSchema>;
/** Untrusted input hints for the operator's correction form; never grant evidence. */
export type UploadCorrectionDraft = {supplier:string;item:string;quantity:string;quantityUnit:string;unitPrice:string;currency:string;leadTimeDays:string;paymentTerms:string;documentText?:string};
type StoredRecord = { documentId:string; originalSha256:string; normalizedSha256?:string; uploadedAt:string; status:'needs_confirmation'|'confirmed'; extracted?:UploadQuotation; correctionDraft?:UploadCorrectionDraft; errors:string[]; path:string };
type Session = { capability:string; expiresAt:number; records:Map<string,StoredRecord> };
const digest=(v:Uint8Array|string)=>createHash('sha256').update(v).digest('hex');
export function hashNormalizedUploadQuotation(data:UploadQuotation){const q=correctionSchema.parse(data);return digest(JSON.stringify(['taskgate:uploaded-quotation:v1',q.supplier,q.item,q.quantity,q.quantityUnit,priceToMinorUnits(q.unitPrice),q.currency,q.leadTimeDays,q.paymentTerms,q.documentText??null]));}
const cap=()=>randomBytes(32).toString('base64url');

function txt(text:string): unknown {
  const fields:Record<string,string>={}; for(const line of text.split(/\r?\n/)){const m=/^([A-Za-z ]+):\s*(.+)$/.exec(line);if(m)fields[m[1].toLowerCase().replaceAll(' ','')]=m[2];}
  return {supplier:fields.supplier,item:fields.item,quantity:Number(fields.quantity),quantityUnit:fields.quantityunit,unitPrice:fields.unitprice,currency:fields.currency,leadTimeDays:Number(fields.leadtimedays),paymentTerms:fields.paymentterms,documentText:text};
}
function object(value:unknown):Record<string,unknown>|undefined {return typeof value==='object'&&value!==null&&!Array.isArray(value)?value as Record<string,unknown>:undefined;}
function correctionDraft(raw:unknown):UploadCorrectionDraft|undefined {
  const root=object(raw);if(!root)return;
  const item=object(root.item),supplier=object(root.supplier),delivery=object(root.delivery),payment=object(root.payment);
  const text=(value:unknown)=>typeof value==='string'&&value.length<=500?value:typeof value==='number'&&Number.isFinite(value)?String(value):'';
  return {
    supplier:text(typeof root.supplier==='string'?root.supplier:supplier?.name),
    item:text(typeof root.item==='string'?root.item:item?.name??item?.description),
    quantity:text(root.quantity??item?.quantity),quantityUnit:text(root.quantityUnit??item?.quantityUnit),
    unitPrice:text(root.unitPrice??item?.unitPrice),currency:text(root.currency??item?.currency),
    leadTimeDays:text(root.leadTimeDays??delivery?.leadTimeDays),paymentTerms:text(root.paymentTerms??payment?.terms),
    ...(typeof root.documentText==='string'&&root.documentText.length<=8000?{documentText:root.documentText}:{})
  };
}
function parse(name:string, contentType:string, bytes:Buffer): { data?:UploadQuotation; correctionDraft?:UploadCorrectionDraft; errors:string[] } {
  if(bytes.length>MAX_BYTES) return {errors:['Document exceeds 2 MB limit.']};
  const ext=/\.([a-z0-9]+)$/i.exec(name)?.[1]?.toLowerCase();
  if((ext==='json'&&contentType!=='application/json')||(ext==='txt'&&!['text/plain','application/octet-stream'].includes(contentType))) return {errors:['Filename and content type do not match allowed formats.']};
  if(ext!=='json'&&ext!=='txt') return {errors:[ext==='pdf'?'PDF uploads are not supported in this milestone.':'Unsupported document format.']};
  let raw:unknown; try { const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes); if(text.includes('\0')) throw new Error(); raw=ext==='json'?JSON.parse(text):txt(text); } catch{return {errors:['Document is not valid UTF-8 structured quotation data.']};}
  const draft=correctionDraft(raw),parsed=correctionSchema.safeParse(raw);
  if(parsed.success)return {data:parsed.data,...(draft?{correctionDraft:draft}:{}),errors:[]};
  const errors=parsed.error.issues.map(issue=>issue.path[0]==='quantityUnit'&&draft!==undefined&&draft.quantityUnit!==''
    ?`Quantity unit "${draft.quantityUnit}" is unsupported. Choose "each" or "kg" before confirming.`
    :`${issue.path.join('.')||'document'}: ${issue.message}`);
  if(draft?.quantityUnit&&draft.quantityUnit!=='each'&&draft.quantityUnit!=='kg'&&!errors.some(error=>error.startsWith('Quantity unit ')))errors.unshift(`Quantity unit "${draft.quantityUnit}" is unsupported. Choose "each" or "kg" before confirming.`);
  return {...(draft?{correctionDraft:draft}:{}),errors};
}
export class QuotationUploadStore {
 private readonly sessions=new Map<string,Session>(); private readonly root:Promise<string>;
 constructor(directory?:string){const path=directory??join(tmpdir(),`taskgate-upload-${randomUUID()}`);this.root=mkdir(path,{recursive:true}).then(()=>path);}
 create(){const sessionId=randomUUID(), capability=cap();this.sessions.set(sessionId,{capability,expiresAt:Date.now()+60*60_000,records:new Map()});return {sessionId,capability,expiresAt:new Date(Date.now()+60*60_000).toISOString(),maxDocuments:2};}
 isAlive(id:string){const s=this.sessions.get(id);return s!==undefined&&s.expiresAt>Date.now();}
 hasCapability(id:string, capability:string){try{this.session(id,capability);return true;}catch{return false;}}
 private session(id:string, capability:string){const s=this.sessions.get(id);if(!s||s.expiresAt<Date.now()||capability.length===0||capability!==s.capability)throw new Error('Unknown upload session');return s;}
 async upload(id:string, capability:string, name:string, contentType:string, bytes:Buffer){const s=this.session(id,capability);if(s.records.size>=2)throw new Error('Upload session already contains two documents');if(!/^[A-Za-z0-9][A-Za-z0-9._ -]{0,120}$/.test(name)||name.includes('..'))throw new Error('Invalid filename');const originalSha256=digest(bytes);if([...s.records.values()].some(r=>r.originalSha256===originalSha256))throw new Error('Duplicate document upload');const result=parse(name,contentType,bytes);const documentId=`doc-${randomUUID()}`, path=join(await this.root,documentId);await writeFile(path,bytes,{flag:'wx'});const record:StoredRecord={documentId,originalSha256,uploadedAt:new Date().toISOString(),status:'needs_confirmation',...(result.data?{extracted:result.data}:{ }),...(result.correctionDraft?{correctionDraft:result.correctionDraft}:{}),errors:result.errors,path};s.records.set(documentId,record);return this.view(record);}
 confirm(id:string, capability:string, documentId:string, input:unknown){const s=this.session(id,capability),r=s.records.get(documentId);if(!r)throw new Error('Unknown uploaded document');const data=correctionSchema.parse(input);r.extracted=data;r.errors=[];r.status='confirmed';r.normalizedSha256=hashNormalizedUploadQuotation(data);return this.view(r);}
 list(id:string, capability:string){return [...this.session(id,capability).records.values()].filter(r=>r.status==='confirmed').map(r=>this.view(r));}
 trustedConfirmed(id:string, capability:string, documentIds:readonly string[]){const s=this.session(id,capability);if(documentIds.length!==2||new Set(documentIds).size!==2)throw new Error('Exactly two distinct confirmed documents are required');return documentIds.map(documentId=>{const r=s.records.get(documentId);if(!r||r.status!=='confirmed'||!r.extracted||!r.normalizedSha256||hashNormalizedUploadQuotation(r.extracted)!==r.normalizedSha256)throw new Error('Document is not confirmed or its metadata changed');return Object.freeze({documentId:r.documentId,originalSha256:r.originalSha256,normalizedSha256:r.normalizedSha256,quotation:Object.freeze(structuredClone(r.extracted))});});}
 viewRecord(id:string,capability:string,doc:string){const r=this.session(id,capability).records.get(doc);if(!r)throw new Error('Unknown uploaded document');return this.view(r);}
 async inspectionInput(id:string,capability:string,documentId:string){
  const r=this.session(id,capability).records.get(documentId);
  if(!r||r.status!=='confirmed'||!r.extracted||!r.normalizedSha256)throw new Error('Confirmed document unavailable');
  const bytes=await readFile(r.path);
  return Object.freeze({documentId:r.documentId,originalSha256:r.originalSha256,computedOriginalSha256:digest(bytes),normalizedSha256:r.normalizedSha256,computedNormalizedSha256:hashNormalizedUploadQuotation(r.extracted),content:new TextDecoder('utf-8',{fatal:true}).decode(bytes),quotation:structuredClone(r.extracted)});
 }
  private view(r:StoredRecord){return {documentId:r.documentId,status:r.status,uploadedAt:r.uploadedAt,originalSha256:r.originalSha256,...(r.normalizedSha256?{normalizedSha256:r.normalizedSha256}:{}),...(r.extracted?{extraction:{supplier:r.extracted.supplier,item:r.extracted.item,quantity:r.extracted.quantity,quantityUnit:r.extracted.quantityUnit,unitPrice:r.extracted.unitPrice,currency:r.extracted.currency,leadTimeDays:r.extracted.leadTimeDays,paymentTerms:r.extracted.paymentTerms}}:{}),...(r.status==='needs_confirmation'&&r.correctionDraft?{correctionDraft:{...r.correctionDraft}}:{}),errors:[...r.errors],trustLabel:'untrusted_document' as const};}
 async close(){this.sessions.clear();await rm(await this.root,{recursive:true,force:true});}
}
