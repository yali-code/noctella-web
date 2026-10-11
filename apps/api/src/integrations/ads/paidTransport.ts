import { requirePaidCredentials, type PaidProviderAccess } from "../../use-cases/ads/paidCampaignCollectorContract";

/** Fixed vendor endpoints only, no caller-controlled host, redirects or raw-error logging. */
export class PaidProviderReadError extends Error {
  constructor(readonly kind:"authentication"|"permission"|"rate_limit"|"temporary"|"rejected"|"malformed",message:string){
    super(message);this.name="PaidProviderReadError";
  }
}
export function isObject(x:unknown):x is Record<string,unknown>{
  return !!x&&typeof x==="object"&&!Array.isArray(x);
}
/**
 * Meta Graph reports expired/invalid tokens (190), missing permissions (10, 200-299) and throttling
 * (4, 17, 32, 613, 80000-80099) mostly as HTTP 400. Only the numeric code is read - the provider
 * message is never surfaced or logged.
 */
async function metaErrorKind(response:Response):Promise<PaidProviderReadError["kind"]|null>{
  try{
    const body:unknown=await response.json();
    const code=isObject(body)&&isObject(body.error)?body.error.code:null;
    if(typeof code!=="number")return null;
    if(code===190)return "authentication";
    if(code===10||(code>=200&&code<=299))return "permission";
    if([4,17,32,613].includes(code)||(code>=80000&&code<=80099))return "rate_limit";
    return null;
  }catch{return null;}
}
export async function paidGetJson(
  url:URL,access:PaidProviderAccess,fetchImpl:typeof fetch=fetch,
  method:"GET"|"POST"="GET",body?:Record<string,unknown>,
  extraHeaders:Readonly<Record<string,string>>={},
):Promise<unknown>{
  requirePaidCredentials(access);
  const allow=["graph.facebook.com","googleads.googleapis.com","api.pinterest.com"];
  if(url.protocol!=="https:"||!allow.includes(url.hostname)||url.username||url.password)throw new PaidProviderReadError("rejected","Unapproved paid provider destination");
  let response:Response;
  try {
    response=await fetchImpl(url.toString(),{
      method,headers:{Authorization:`Bearer ${access.accessToken}`,Accept:"application/json",
        ...(method==="POST"?{"Content-Type":"application/json"}:{}),...extraHeaders},
      ...(body?{body:JSON.stringify(body)}:{}),
      redirect:"error",signal:AbortSignal.timeout(15000),
    });
  }catch{
    throw new PaidProviderReadError("temporary","Paid provider transport failed");
  }
  if(!response.ok){
    const kind=(url.hostname==="graph.facebook.com"?await metaErrorKind(response):null)
      ?? (response.status===401?"authentication":response.status===403?"permission":
        response.status===429?"rate_limit":response.status>=500?"temporary":"rejected");
    throw new PaidProviderReadError(kind,`Paid provider returned HTTP ${response.status}`);
  }
  try {
    const parsed:unknown=await response.json();
    if(!parsed||typeof parsed!=="object")throw Error();
    return parsed;
  }catch{throw new PaidProviderReadError("malformed","Paid provider JSON response was malformed");}
}
