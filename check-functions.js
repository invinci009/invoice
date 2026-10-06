const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf8');

const defined = new Set();
const called = new Set();

// function declarations
const funcDeclRegex = /function\s+(\w+)\s*\(/g;
let m;
while ((m = funcDeclRegex.exec(code)) !== null) defined.add(m[1]);

// const/let/var arrow functions
const varFuncRegex = /(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?\(/g;
while ((m = varFuncRegex.exec(code)) !== null) defined.add(m[1]);

// method shorthand in objects
const methodRegex = /^\s*(\w+)\s*\([^)]*\)\s*\{/gm;
while ((m = methodRegex.exec(code)) !== null) defined.add(m[1]);

// built-in globals
const builtins = new Set(['if','for','while','switch','catch','function','return','typeof','new','delete','void','in','of','do','else','try','finally','throw','class','extends','super','this','null','undefined','true','false','console','document','window','fetch','alert','confirm','prompt','setTimeout','setInterval','clearTimeout','clearInterval','JSON','Math','Date','Array','Object','String','Number','Boolean','RegExp','Error','TypeError','RangeError','Promise','Map','Set','WeakMap','WeakSet','Symbol','Proxy','Reflect','Intl','URL','URLSearchParams','Blob','File','FileReader','FormData','Headers','Request','Response','WebSocket','Worker','SharedWorker','ServiceWorker','Notification','MediaQueryList','IntersectionObserver','MutationObserver','PerformanceObserver','ResizeObserver','getComputedStyle','getSelection','scrollTo','scrollBy','focus','blur','click','submit','reset','select','remove','appendChild','removeChild','insertBefore','replaceChild','cloneNode','contains','hasAttribute','getAttribute','setAttribute','removeAttribute','hasOwnProperty','isPrototypeOf','propertyIsEnumerable','toString','valueOf','charAt','charCodeAt','codePointAt','concat','includes','indexOf','lastIndexOf','slice','splice','join','push','pop','shift','unshift','sort','reverse','fill','copyWithin','entries','keys','values','find','findIndex','filter','map','reduce','reduceRight','some','every','forEach','flat','flatMap','from','isArray','assign','create','defineProperty','defineProperties','getOwnPropertyDescriptor','getOwnPropertyDescriptors','getOwnPropertyNames','getOwnPropertySymbols','getPrototypeOf','setPrototypeOf','freeze','seal','isFrozen','isSealed','isExtensible','preventExtensions','parse','stringify','now','UTC','parseFloat','parseInt','isNaN','isFinite','decodeURI','encodeURI','decodeURIComponent','encodeURIComponent','escape','unescape','eval','require','module','exports','global','process','Buffer','__dirname','__filename']);

// function calls
const callRegex = /(?<!\.)\b(\w+)\s*\(/g;
while ((m = callRegex.exec(code)) !== null) {
  const name = m[1];
  if (!builtins.has(name) && !defined.has(name)) called.add(name);
}

if (called.size) {
  console.log('Potentially undefined functions:', [...called].sort());
} else {
  console.log('All called functions appear to be defined');
}
