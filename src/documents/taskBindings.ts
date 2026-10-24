import { randomUUID } from 'node:crypto';
import type { QuotationUploadStore } from './quotationUploads.js';
import { hashNormalizedUploadQuotation } from './quotationUploads.js';
import { hashQuotationSource } from '../agents/quotation.js';
import { mapProcurementQuoteData } from '../agents/quotationSchemas.js';

type Bound = Readonly<{documentId:string;originalSha256:string;normalizedSha256:string;quotation:{supplier:string;item:string;quantity:number;quantityUnit:'each'|'kg';unitPrice:number|string;currency:'INR'|'USD'|'EUR'|'GBP';leadTimeDays:number;paymentTerms:string;documentText?:string}}>;
export type UploadTaskBinding=Readonly<{taskId:string;sessionId:string;createdAt:string;aliases:Readonly<Record<'quote-A'|'quote-B',Bound>>}>;
export class UploadTaskBindings {
 private readonly byTask=new Map<string,UploadTaskBinding>();
 create(store:QuotationUploadStore,sessionId:string,capability:string,documentIds:readonly string[]){const docs=store.trustedConfirmed(sessionId,capability,documentIds) as [Bound,Bound];const taskId=`upload-${randomUUID()}`;const binding=Object.freeze({taskId,sessionId,createdAt:new Date().toISOString(),aliases:Object.freeze({'quote-A':docs[0],'quote-B':docs[1]})});this.byTask.set(taskId,binding);return binding;}
 get(taskId:string){return this.byTask.get(taskId);}
 isAvailable(store:QuotationUploadStore,taskId:string){return this.byTask.has(taskId)&&store.isAlive(this.byTask.get(taskId)!.sessionId);}
 read(taskId:string,alias:'quote-A'|'quote-B'){const binding=this.byTask.get(taskId);if(!binding) return;const d=binding.aliases[alias];if(hashNormalizedUploadQuotation(d.quotation)!==d.normalizedSha256)throw new Error('Bound quotation integrity mismatch');return {...d.quotation,fileId:alias};}
 source(taskId:string,alias:'quote-A'|'quote-B'){const d=this.byTask.get(taskId)?.aliases[alias];if(!d)return;const quote=this.read(taskId,alias)!;return {taskId,fileId:alias,documentId:d.documentId,sha256:hashQuotationSource(mapProcurementQuoteData(quote))};}
 provenance(taskId:string,alias:'quote-A'|'quote-B'){const b=this.byTask.get(taskId);const d=b?.aliases[alias];return d&&Object.freeze({taskId,sessionId:b.sessionId,documentId:d.documentId,originalSha256:d.originalSha256,normalizedSha256:d.normalizedSha256});}
}
