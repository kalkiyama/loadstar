import { filterSubSamples } from '../../api/src/services/subSampleFilter.mjs';
let p=0,f=0; const ok=(n,c,d)=>{c?(console.log('  \u2713 '+n),p++):(console.log('  \u2717 '+n+(d?'  -> '+JSON.stringify(d):'')),f++)};
const P=(name,codes={'200':10})=>({name,requests:10,errors:0,status_codes:codes});
const S=(name,of,codes,errors=0,af=0)=>({name,sub_sample:true,sub_of:of,requests:10,errors,assertion_failures:af,status_codes:codes});

console.log('\nCASE 1 - the clean redirect chain (tonight\u2019s run)');
{
  const r=[P('Guntur'),S('Guntur-0','Guntur',{'301':28}),S('Guntur-1','Guntur',{'200':28})];
  const out=filterSubSamples(r);
  ok('both healthy hops are dropped', out.rows.length===1 && out.dropped===2, out.rows.map(x=>x.name));
  ok('the parent always survives', out.rows[0].name==='Guntur');
}
console.log('\nCASE 2 - unhealthy hops are KEPT (the whole point)');
{
  ok('a 500ing redirect hop is kept',
     filterSubSamples([P('a'),S('a-0','a',{'500':5},5)]).rows.length===2);
  ok('a 404 sub-request is kept even with 0 errors (expected-status case)',
     filterSubSamples([P('a'),S('a-0','a',{'404':5},0)]).rows.length===2);
  ok('an assertion-failing hop is kept',
     filterSubSamples([P('a'),S('a-0','a',{'200':5},0,3)]).rows.length===2);
  ok('a hop with errors but 2xx codes is kept (network failures)',
     filterSubSamples([P('a'),S('a-0','a',{'200':5},2)]).rows.length===2);
}
console.log('\nCASE 3 - parents are never filtered, whatever their state');
{
  const out=filterSubSamples([P('slow',{'500':10}),P('ok')]);
  ok('a 500ing parent stays', out.rows.length===2 && out.dropped===0);
}
console.log('\nCASE 4 - edges');
{
  ok('empty and non-array inputs are safe',
     filterSubSamples([]).rows.length===0 && filterSubSamples(null).dropped===0);
  ok('a hop with no status codes at all is dropped as healthy',
     filterSubSamples([P('a'),S('a-0','a',{})]).dropped===1);
  ok('mixed: one clean hop dropped, one broken hop kept',
     filterSubSamples([P('a'),S('a-0','a',{'301':5}),S('a-1','a',{'502':5},5)]).rows.length===2);
}
console.log('\nPASS '+p+'  FAIL '+f); process.exit(f?1:0);
