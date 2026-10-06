const fs = require('fs');
const code = fs.readFileSync('public/app.js', 'utf8');
const html = fs.readFileSync('public/index.html', 'utf8');

// Check for undefined function calls
const funcDefs = [...code.matchAll(/function\s+(\w+)\s*\(/g)].map(m => m[1]);
const funcCalls = [...code.matchAll(/(?<![.\w])(\w+)\s*\(/g)].map(m => m[1]);
const builtins = new Set(['if','for','while','switch','catch','return','function','typeof','new','delete','void','in','of','do','else','try','finally','throw','class','extends','super','this','null','undefined','true','false','console','document','window','fetch','alert','confirm','prompt','setTimeout','setInterval','clearTimeout','clearInterval','JSON','Math','Date','Array','Object','String','Number','Boolean','RegExp','Error','TypeError','RangeError','Promise','Map','Set','WeakMap','WeakSet','Symbol','Proxy','Reflect','Intl','BigInt','ArrayBuffer','SharedArrayBuffer','DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','escape','unescape','encodeURI','decodeURI','encodeURIComponent','decodeURIComponent','isNaN','isFinite','parseFloat','parseInt','eval','require','module','exports','global','process','Buffer','__dirname','__filename']);

const undefinedCalls = funcCalls.filter(c => !funcDefs.includes(c) && !builtins.has(c));
if (undefinedCalls.length > 0) {
  const unique = [...new Set(undefinedCalls)];
  console.log('Potentially undefined function calls:', unique.join(', '));
} else {
  console.log('No undefined function calls found');
}

// Check for missing DOM elements
const idRefs = [...code.matchAll(/\$\('#(\w+)'\)/g)].map(m => m[1]);
const htmlIds = [...html.matchAll(/id="(\w+)"/g)].map(m => m[1]);
const missingIds = idRefs.filter(id => !htmlIds.includes(id));
if (missingIds.length > 0) {
  const unique = [...new Set(missingIds)];
  console.log('Missing DOM IDs:', unique.join(', '));
} else {
  console.log('All DOM IDs found');
}

// Check for event listeners on elements that might not exist
const eventListeners = [...code.matchAll(/\$\('#(\w+)'\)\.on\w+\(/g)].map(m => m[1]);
const missingEventIds = eventListeners.filter(id => !htmlIds.includes(id));
if (missingEventIds.length > 0) {
  const unique = [...new Set(missingEventIds)];
  console.log('Event listeners on missing IDs:', unique.join(', '));
}

// Check for template literals with undefined variables
const templateVars = [...code.matchAll(/\$\{(\w+)\}/g)].map(m => m[1]);
const definedVars = new Set([...code.matchAll(/(?:const|let|var)\s+(\w+)/g)].map(m => m[1]));
const undefinedVars = templateVars.filter(v => !definedVars.has(v) && !builtins.has(v));
if (undefinedVars.length > 0) {
  const unique = [...new Set(undefinedVars)];
  console.log('Potentially undefined template variables:', unique.join(', '));
}

console.log('\n--- Checking for common runtime issues ---');

// Check for potential null/undefined access
const nullChecks = [...code.matchAll(/(\w+)\.(\w+)/g)];
const riskyAccess = nullChecks.filter(m => {
  const obj = m[1];
  return !['this','window','document','console','JSON','Math','Date','Array','Object','String','Number','Boolean','RegExp','Error','Promise','Map','Set','Symbol','Proxy','Reflect','Intl','BigInt','ArrayBuffer','SharedArrayBuffer','DataView','Int8Array','Uint8Array','Uint8ClampedArray','Int16Array','Uint16Array','Int32Array','Uint32Array','Float32Array','Float64Array','BigInt64Array','BigUint64Array','escape','unescape','encodeURI','decodeURI','encodeURIComponent','decodeURIComponent','isNaN','isFinite','parseFloat','parseInt','eval','require','module','exports','global','process','Buffer','__dirname','__filename'].includes(obj);
});
console.log('Total property access patterns found:', nullChecks.length);

// Check for async/await usage
const asyncFuncs = [...code.matchAll(/async\s+function\s+(\w+)/g)].map(m => m[1]);
const awaitCalls = [...code.matchAll(/await\s+/g)].length;
console.log('Async functions:', asyncFuncs.length, '| Await calls:', awaitCalls);

// Check for error handling
const tryCatch = [...code.matchAll(/try\s*\{/g)].length;
const catchBlocks = [...code.matchAll(/catch\s*\(/g)].length;
console.log('Try blocks:', tryCatch, '| Catch blocks:', catchBlocks);

// Check for console.log statements (potential debug leftovers)
const consoleLogs = [...code.matchAll(/console\.log/g)].length;
console.log('Console.log statements:', consoleLogs);

// Check for TODO/FIXME comments
const todos = [...code.matchAll(/TODO|FIXME|HACK|XXX/gi)].map(m => m[0]);
if (todos.length > 0) {
  console.log('TODO/FIXME markers found:', todos.join(', '));
}

console.log('\n--- Analysis complete ---');
