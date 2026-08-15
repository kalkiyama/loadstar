import { subSampleSummary, fmtSubMs } from '../subsample_summary.mjs';
let p=0,f=0; const ok=(n,c,d)=>{c?(console.log('  \u2713 '+n),p++):(console.log('  \u2717 '+n+(d?'  -> '+JSON.stringify(d):'')),f++)};
const P=(name,p95)=>({name,p95_ms:p95,requests:10});
const S=(name,of,avg,hop,idx=0)=>({name,sub_sample:true,sub_of:of,sub_index:idx,avg_ms:avg,redirect_hop:hop,requests:10});

console.log('\nCASE 1 - the real observed run');
{
  const parent=P('Test Collage From Guntur',2870);
  const rows=[parent,S('Test Collage From Guntur-0','Test Collage From Guntur',625,true,0),
                     S('Test Collage From Guntur-1','Test Collage From Guntur',1253,false,1)];
  const s=subSampleSummary(parent,rows);
  ok('counts both sub-requests', s.count===2, s);
  ok('counts one redirect hop', s.redirect_count===1);
  ok('redirect time counts the hop only, not the 200 sub-request', s.redirect_ms===625, s);
  ok('text reads as intended', s.text==='2 sub-requests \u00b7 625ms in redirect', s.text);
}
console.log('\nCASE 2 - a parent with no children');
{ const parent=P('solo',100); ok('returns null so the UI renders nothing', subSampleSummary(parent,[parent])===null); }
console.log('\nCASE 3 - only the right parent\u2019s children count');
{
  const a=P('a',10), b=P('b',20);
  const rows=[a,b,S('a-0','a',50,true),S('b-0','b',900,true),S('b-1','b',80,true,1)];
  ok('parent a sees only its own', subSampleSummary(a,rows).count===1);
  ok('parent b sees only its own', subSampleSummary(b,rows).count===2);
  ok('b\u2019s redirect total sums both hops', subSampleSummary(b,rows).redirect_ms===980);
}
console.log('\nCASE 4 - formatting');
{
  const parent=P('p',10); const rows=[parent,S('p-0','p',1100,true)];
  ok('1100ms renders as 1.1s', subSampleSummary(parent,rows).text==='1 sub-request \u00b7 1.1s in redirect', subSampleSummary(parent,rows).text);
  ok('fmtSubMs boundaries', fmtSubMs(999)==='999ms' && fmtSubMs(1000)==='1s' && fmtSubMs(1500)==='1.5s' && fmtSubMs(0)==='0ms');
}
console.log('\nCASE 5 - non-redirect children only');
{
  const parent=P('p',10); const s=subSampleSummary(parent,[parent,S('p-0','p',300,false)]);
  ok('no redirect clause when there are no hops', s.text==='1 sub-request', s.text);
  ok('redirect_ms is 0', s.redirect_ms===0);
}
console.log('\nCASE 6 - garbage in');
{
  ok('null/undefined are safe', subSampleSummary(null,[])===null && subSampleSummary(P('x',1),null)===null);
  const parent=P('p',10);
  ok('a hop with a missing avg does not produce NaN', subSampleSummary(parent,[parent,S('p-0','p',undefined,true)]).redirect_ms===0);
}
console.log('\nPASS '+p+'  FAIL '+f); process.exit(f?1:0);
