// Throwaway smoke check: load the browser half with a stub loader/ctx and make
// sure it registers the sidebar entry and the main panel.
const fs = require('fs');
const path = require('path');
const src = fs.readFileSync(path.join(__dirname, 'client.js'), 'utf8');
let captured;
global.window = { __ModuleLoader__: { load: (m) => { captured = m; } } };
new Function(src)();

const React = {
  createElement: (...args) => ({ type: args[0], props: args[1] }),
  useState: () => [null, () => {}],
  useEffect: () => {},
  useRef: () => ({ current: null }),
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
};
const mod = captured.factory((id) => {
  if (id === 'react') return React;
  throw new Error('unexpected require: ' + id);
});

const registered = [];
const ctx = {
  slots: {
    inject: (_name, cb) => { cb(); return () => {}; },
    register: (seat, comp) => { registered.push([seat.name, seat.id || seat.key, typeof comp]); return () => {}; },
  },
  locale: { register: () => {}, bind: () => (k) => k },
  get: () => undefined,
  effect: (fn) => { fn(); },
};

mod.apply(ctx);
console.log('module id  :', captured.id);
console.log('inject     :', JSON.stringify(mod.inject));
console.log('registered :', JSON.stringify(registered));
if (!captured.id) throw new Error('missing module id');
if (registered.length !== 2) throw new Error('expected 2 slot registrations, got ' + registered.length);
if (registered[0][0] !== 'sidebar.panellist' || registered[0][1] !== 'webchat') throw new Error('bad sidebar entry');
if (registered[1][0] !== 'main' || registered[1][1] !== 'webchat') throw new Error('bad main panel');
console.log('SMOKE OK');
