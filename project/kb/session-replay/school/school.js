/* replay-school shared script: theme, page list, progress, quizzes, step-through flows.
   No network. Every page works without this file except the demos and quizzes. */
(function(){
var root=document.documentElement;
var RS=window.RS={};
RS.reduce=matchMedia('(prefers-reduced-motion: reduce)').matches;
RS.esc=function(s){return String(s).replace(/[&<>"]/g,function(c){return{'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]})};
RS.NS='http://www.w3.org/2000/svg';
RS.el=function(p,tag,a,txt){var e=document.createElementNS(RS.NS,tag);for(var k in a){var v=a[k];if((k==='fill'||k==='stroke')&&String(v).indexOf('var(')===0)e.style.setProperty(k,v);else e.setAttribute(k,v)}if(txt!==undefined)e.textContent=txt;p.appendChild(e);return e};
RS.cssv=function(n){return 'var('+n+')'};
function store(k,v){try{if(v===undefined)return localStorage.getItem(k);localStorage.setItem(k,v)}catch(e){return null}}

/* the course, in order. Also drives the contents page ticks. */
RS.PAGES=[
 ['index','Contents','Start'],
 ['f1-pixels-vs-structure','Pixels versus structure','Fundamentals'],
 ['f2-event-loop-and-frames','The event loop and frames','Fundamentals'],
 ['f3-view-trees','View trees, platform by platform','Fundamentals'],
 ['f4-keyframes-and-deltas','Keyframes and deltas','Fundamentals'],
 ['f5-compression','Compression basics, and how H.264 skips','Fundamentals'],
 ['f6-masking-data-vs-geometry','Masking: data versus geometry','Fundamentals'],
 ['t1-hooks','When to look: hooks','Topics'],
 ['t2-what-to-record','What to record','Topics'],
 ['t3-masking-race','How to mask: the masking race','Topics'],
 ['t4-packing','How to pack','Topics'],
 ['t5-sending','When to send, and how ouo ships','Topics'],
 ['t6-playing','How to play','Topics'],
 ['w1-rrweb','rrweb: the engine','Techniques · web'],
 ['w2-sentry-web','Sentry on the web','Techniques · web'],
 ['w3-posthog-web','PostHog on the web','Techniques · web'],
 ['w4-datadog-web','Datadog on the web','Techniques · web'],
 ['w5-openreplay-highlight-clarity','OpenReplay, Highlight, Clarity','Techniques · web'],
 ['m1-sentry-ios','Sentry iOS','Techniques · mobile'],
 ['m2-sentry-android','Sentry Android','Techniques · mobile'],
 ['m3-posthog-mobile','PostHog iOS and Android','Techniques · mobile'],
 ['m4-datadog-mobile','Datadog iOS and Android','Techniques · mobile'],
 ['m5-openreplay-mobile','OpenReplay iOS and Android','Techniques · mobile'],
 ['m6-react-native','React Native','Techniques · cross-platform'],
 ['m7-flutter','Flutter','Techniques · cross-platform'],
 ['z1-six-steps','Six steps, and what ouo borrows','Finale']
];

/* theme */
var tb=document.getElementById('themeBtn');
function cur(){return root.getAttribute('data-theme')||(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light')}
function lbl(){if(tb)tb.textContent=cur()==='dark'?'☀ light':'☾ dark'}
if(tb)tb.onclick=function(){var n=cur()==='dark'?'light':'dark';root.setAttribute('data-theme',n);store('sr-theme',n);lbl()};
lbl();

/* progress bar and crumb */
var id=document.body.getAttribute('data-page'),idx=-1;
RS.PAGES.forEach(function(p,i){if(p[0]===id)idx=i});
var bar=document.querySelector('.top .bar');
if(bar&&idx>0)bar.style.width=(idx/(RS.PAGES.length-1)*100)+'%';
var crumb=document.querySelector('.top .crumb');
if(crumb&&idx>0)crumb.textContent=RS.PAGES[idx][2]+' · lesson '+idx+' of '+(RS.PAGES.length-1);

/* contents page: tick lessons whose quiz was completed in this browser */
document.querySelectorAll('.lessons a[data-id]').forEach(function(a){if(store('rs-done-'+a.dataset.id))a.classList.add('done')});

/* quizzes: <script type="application/json" class="quiz-data">[{q,a:[..],c,why}]</script> */
document.querySelectorAll('script.quiz-data').forEach(function(s){
 var qs;try{qs=JSON.parse(s.textContent)}catch(e){return}
 var host=document.createElement('div');s.parentNode.insertBefore(host,s);
 var score=document.querySelector('.check h2 .score'),answered=0,right=0;
 function upd(){if(score)score.textContent=right+' / '+qs.length+(answered===qs.length?' · done':'');if(answered===qs.length&&id)store('rs-done-'+id,'1')}
 function build(){host.innerHTML='';answered=0;right=0;
 qs.forEach(function(q,qi){
  var d=document.createElement('div');d.className='q';
  d.innerHTML='<p class="qt">'+(qi+1)+'. '+q.q+'</p><div class="opts" role="group"></div><div class="why" aria-live="polite"></div>';
  var opts=d.querySelector('.opts'),why=d.querySelector('.why');
  /* options are shuffled on every build so the right answer has no fixed place */
  var order=q.a.map(function(_,k){return k});for(var k=order.length-1;k>0;k--){var r=Math.floor(Math.random()*(k+1)),tmp=order[k];order[k]=order[r];order[r]=tmp}
  order.forEach(function(ai){var t=q.a[ai],b=document.createElement('button');b.type='button';b.className='opt';b.innerHTML=t;b.dataset.ai=ai;
   b.onclick=function(){if(d.dataset.done)return;d.dataset.done='1';answered++;var ok=ai===q.c;if(ok)right++;
    opts.querySelectorAll('button').forEach(function(x){var xi=+x.dataset.ai;x.disabled=true;if(xi===q.c)x.classList.add('right');else if(xi===ai)x.classList.add('wrong')});
    why.innerHTML=(ok?'<b class="ok">Right.</b> ':'<b class="no">Not quite.</b> ')+q.why;upd()};
   opts.appendChild(b)});
  host.appendChild(d)});
 upd()}
 build();
 var again=document.createElement('button');again.type='button';again.className='b';again.textContent='↺ try again';
 again.onclick=build;
 host.parentNode.insertBefore(again,host.nextSibling);
});

/* keyboard: left / right arrows move between lessons when focus is not in a control */
document.addEventListener('keydown',function(e){if(e.altKey||e.ctrlKey||e.metaKey||e.shiftKey)return;var t=e.target.tagName;if(t==='INPUT'||t==='SELECT'||t==='TEXTAREA'||t==='BUTTON')return;
 var a=e.key==='ArrowRight'?document.querySelector('nav.pn a.next'):e.key==='ArrowLeft'?document.querySelector('nav.pn a.prev'):null;if(a&&a.href)location.href=a.href});

/* step-through flow: boxes light up, caption shows the step and its pinned source links */
window.ouoFlow=function(host,f){
 var w=document.createElement('div');w.className='card';w.id=f.id;
 var h=(f.title?'<h3 style="margin-top:0">'+f.title+'</h3>':'')+(f.intro?'<p>'+f.intro+'</p>':'')+'<div class="pipe">'+f.boxes.map(function(b){return '<div class="st" data-b="'+b[0]+'"><b>'+b[1]+'</b><span class="mut">'+(b[2]||'')+'</span></div>'}).join('')+'</div>'+
  '<div class="btns"><button class="b" data-a="prev" type="button">◀ prev</button><button class="b" data-a="next" type="button">next ▶</button><button class="b" data-a="play" type="button">▶ play all</button><span class="mut" style="font-size:12px" data-n></span></div><div class="step-caption" data-cap aria-live="polite" style="min-height:5em"></div>';
 w.innerHTML=h;host.appendChild(w);
 var i=-1,tm=null,cap=w.querySelector('[data-cap]'),num=w.querySelector('[data-n]');
 function link(l){return '<a href="'+l[1]+'">'+l[0]+'</a>'}
 function go(n){i=Math.max(0,Math.min(f.steps.length-1,n));var s=f.steps[i];
  w.querySelectorAll('.st').forEach(function(e){e.classList.toggle('act',e.dataset.b===s[0])});
  cap.innerHTML=s[1]+(s[2]&&s[2].length?'<div class="src" style="margin-top:4px">Source: '+s[2].map(link).join(' · ')+'</div>':'');num.textContent='step '+(i+1)+' / '+f.steps.length}
 w.querySelector('[data-a=prev]').onclick=function(){go(i-1)};
 w.querySelector('[data-a=next]').onclick=function(){go(i+1)};
 w.querySelector('[data-a=play]').onclick=function(){var b=this;if(tm){clearInterval(tm);tm=null;b.textContent='▶ play all';return}b.textContent='❚❚ pause';if(i>=f.steps.length-1)i=-1;go(i+1);tm=setInterval(function(){if(i>=f.steps.length-1){clearInterval(tm);tm=null;b.textContent='▶ play all';return}go(i+1)},RS.reduce?6000:4200)};
 cap.innerHTML=f.steps.length+' steps. Press next.';
};
})();
