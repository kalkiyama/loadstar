import { markSubSamples, sortWithSubSamples } from '../subsamples.mjs';
let pass=0, fail=0;
const ok=(n,c,d)=>{ if(c){console.log('  \u2713 '+n);pass++;} else {console.log('  \u2717 '+n+(d?'  -> '+JSON.stringify(d):''));fail++;} };
const R=(name,p95,codes,requests=10)=>({name,p95_ms:p95,requests,status_codes:codes});
const tag=(r)=>!r||!r.sub_sample?"":(r.redirect_hop?"redirect hop":"sub-request");

console.log('\nCASE 1 - the REAL observed run (one url, apex 301 -> https://www)');
{
  const rows=[R('Test Collage From Guntur',4591,{'200':24}),
              R('Test Collage From Guntur-1',3392,{'200':24}),
              R('Test Collage From Guntur-0',1765,{'301':24})];
  markSubSamples(rows);
  const b=Object.fromEntries(rows.map(r=>[r.name,r]));
  ok('-0 (301 only) is a sub-sample AND a redirect hop',
     b['Test Collage From Guntur-0'].sub_sample===true && b['Test Collage From Guntur-0'].redirect_hop===true);
  ok('-1 (200s) is a sub-sample but NOT a redirect hop',
     b['Test Collage From Guntur-1'].sub_sample===true && b['Test Collage From Guntur-1'].redirect_hop===false);
  ok('the parent is neither', !b['Test Collage From Guntur'].sub_sample);
  ok('labels read correctly',
     tag(b['Test Collage From Guntur-0'])==='redirect hop' &&
     tag(b['Test Collage From Guntur-1'])==='sub-request' && tag(b['Test Collage From Guntur'])==='');
  const s=sortWithSubSamples(rows);
  ok('renders parent, then -0, then -1 - the journey in order',
     s.map(r=>r.name).join(' | ')==='Test Collage From Guntur | Test Collage From Guntur-0 | Test Collage From Guntur-1',
     s.map(r=>r.name));
}

console.log('\nCASE 2 - guards');
{
  const rows=[R('search-1',400,{'301':5})];
  markSubSamples(rows);
  ok('a suffixed row with NO parent present is untouched', !rows[0].sub_sample);
}
{
  const rows=[R('checkout',900,{'200':50}), R('checkout-0',800,{'200':50})];
  markSubSamples(rows);
  ok('B-WIDE, stated honestly: a real endpoint named checkout-0 IS labelled a sub-request',
     rows[1].sub_sample===true && rows[1].redirect_hop===false);
  ok('  - but it keeps every number it had',
     rows[1].p95_ms===800 && rows[1].requests===10 && rows[1].status_codes['200']===50);
}
{
  const rows=[R('api',100,{'200':5}), R('api-0',90,{})];
  markSubSamples(rows);
  ok('a sub-sample with no status codes is not called a redirect', rows[1].sub_sample===true && rows[1].redirect_hop===false);
}
{
  const rows=[R('api',100,{'200':5}), R('api-0',90,{'301':4,'200':1})];
  markSubSamples(rows);
  ok('mixed 301+200 is a sub-sample, not a pure redirect hop', rows[1].sub_sample===true && rows[1].redirect_hop===false);
}

console.log('\nCASE 3 - the p95-DESC promise for parents survives');
{
  const rows=[R('slow',5000,{'200':10}), R('fast',100,{'200':10}),
              R('mid',900,{'200':10}), R('slow-0',10,{'302':10})];
  const s=sortWithSubSamples(markSubSamples(rows));
  ok('parents still slow > mid > fast', s.filter(r=>!r.sub_sample).map(r=>r.name).join(',')==='slow,mid,fast');
  ok('a fast sub-sample does not sink; it follows its parent', s[1].name==='slow-0', s.map(r=>r.name));
}

console.log('\nCASE 4 - nothing is ever dropped');
{
  const rows=[R('a',10,{'200':1}), R('a-0',5,{'301':1}), R('b',20,{'200':1}), R('orphan-3',1,{'301':1})];
  const s=sortWithSubSamples(markSubSamples(rows));
  ok('all four rows survive, orphan included', s.length===4 && s.some(r=>r.name==='orphan-3'), s.map(r=>r.name));
  ok('empty / single-row inputs are safe',
     markSubSamples([]).length===0 && sortWithSubSamples([]).length===0 && markSubSamples([R('x',1,{})]).length===1);
}

console.log('\nCASE 5 - idempotent (the merge path may re-run it)');
{
  const rows=[R('p',100,{'200':1}), R('p-0',50,{'301':1})];
  markSubSamples(rows); const first=JSON.stringify(rows);
  markSubSamples(rows);
  ok('running detection twice changes nothing', JSON.stringify(rows)===first);
  const a=sortWithSubSamples(rows), b=sortWithSubSamples(a);
  ok('sorting twice changes nothing', a.map(r=>r.name).join()===b.map(r=>r.name).join());
}

console.log('\nPASS '+pass+'  FAIL '+fail);
process.exit(fail?1:0);
