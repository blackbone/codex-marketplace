// Preserve actionable command failures without exposing credentials or bound input.
const secretKey = /^(?:.*token|authorization|password|secret|credentials)$/i;
const diagnosticKey = /^(?:errors?|errorDetails|warnings?|logs?|message|details)$/i;
function parsed(value) {
  if (typeof value !== 'string' || value.length > 1024*1024 || !/^[\s]*[\[{]/.test(value)) return value;
  try { return JSON.parse(value); } catch { return value; }
}
export function resultPayload(result) { return parsed(result?.data?.data?.result); }
export function safeResult(value, token) {
  const secrets = new Set(token ? [token] : []);
  function collect(v, sensitive=false, depth=0) {
    if (depth > 20) return;
    if (typeof v === 'string') {
      if (sensitive && v.length >= 4) secrets.add(v);
      const decoded = parsed(v);
      if (decoded !== v) collect(decoded,sensitive,depth+1);
    } else if (Array.isArray(v)) v.forEach(item=>collect(item,sensitive,depth+1));
    else if (v && typeof v === 'object') for (const [key,item] of Object.entries(v)) collect(item,sensitive || secretKey.test(key) || (key==='parameters' && !Array.isArray(item)),depth+1);
  }
  collect(value);
  const replacements = [...secrets].sort((a,b)=>b.length-a.length);
  function clean(v, diagnostic=false, depth=0) {
    if (depth>20) return '[truncated]';
    if (typeof v === 'string') {
      const decoded=parsed(v);
      if (decoded !== v) return JSON.stringify(clean(decoded,diagnostic,depth+1));
      for (const secret of replacements) v=v.replaceAll(secret,'[redacted]');
      v=v.replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+=*/gi,'Bearer [redacted]');
      v=v.replace(/(https?:\/\/)[^\s/@]+@/gi,'$1[redacted]@');
      v=v.replace(/([?&](?:access_token|token|password|secret|api_key)=)[^&#\s]+/gi,'$1[redacted]');
      return diagnostic && v.length>2000 ? v.slice(0,2000)+' [truncated]' : v;
    }
    if (Array.isArray(v)) {
      const values=(diagnostic?v.slice(0,20):v).map(item=>clean(item,diagnostic,depth+1));
      if(diagnostic && v.length>20) values.push(`[${v.length-20} more entries omitted]`);
      return values;
    }
    if (!v || typeof v !== 'object') return v;
    return Object.fromEntries(Object.entries(v)
      .filter(([key,item])=>!secretKey.test(key) && key!=='stackTrace' && !(key==='parameters' && !Array.isArray(item)))
      .map(([key,item])=>[key,clean(item,diagnostic || diagnosticKey.test(key),depth+1)]));
  }
  return clean(value);
}
