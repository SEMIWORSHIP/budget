// Хранилище. Два варианта с одинаковым набором методов:
// live — Firebase, общий для двоих; demo — localStorage, только этот браузер.
import { config } from './config.js';

export async function createStore() {
  // ?demo в адресе — пробный режим на данных этого браузера, общую базу не трогает.
  const demo = new URLSearchParams(location.search).has('demo');
  return config.firebase && !demo ? createLiveStore() : createDemoStore();
}

async function createLiveStore() {
  const fb = await import('../vendor/firebase.js');
  const app = fb.initializeApp(config.firebase);
  const auth = fb.getAuth(app);
  const db = fb.getFirestore(app);
  const docs = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data() }));

  return {
    demo: false,
    onAuth(cb) {
      return fb.onAuthStateChanged(auth, (u) => cb(u ? { uid: u.uid, email: u.email } : null));
    },
    signIn(email, password) {
      return fb.signInWithEmailAndPassword(auth, email.trim(), password);
    },
    signOut() {
      return fb.signOut(auth);
    },
    watchCol(path, cb, onError) {
      return fb.onSnapshot(fb.collection(db, path), (s) => cb(docs(s)), onError);
    },
    watchDoc(path, cb, onError) {
      return fb.onSnapshot(fb.doc(db, path), (s) => cb(s.exists() ? { id: s.id, ...s.data() } : null), onError);
    },
    newId(colPath) {
      return fb.doc(fb.collection(db, colPath)).id;
    },
    save(path, data, merge = true) {
      return fb.setDoc(fb.doc(db, path), data, { merge });
    },
    remove(path) {
      return fb.deleteDoc(fb.doc(db, path));
    },
  };
}

function createDemoStore() {
  const KEY = 'budget-demo-v1';
  const USER_KEY = 'budget-demo-user';
  let data = {};
  try { data = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { data = {}; }
  let user = null;
  try { user = JSON.parse(localStorage.getItem(USER_KEY)); } catch { user = null; }

  const listeners = new Set();
  let authCb = () => {};

  const persist = () => {
    try { localStorage.setItem(KEY, JSON.stringify(data)); } catch { /* приватный режим */ }
  };
  const lastSeg = (p) => p.slice(p.lastIndexOf('/') + 1);
  const fire = (l) => {
    if (l.type === 'doc') {
      l.cb(data[l.path] ? { id: lastSeg(l.path), ...data[l.path] } : null);
      return;
    }
    const pre = l.path + '/';
    const out = [];
    for (const [p, v] of Object.entries(data)) {
      if (p.startsWith(pre) && !p.slice(pre.length).includes('/')) out.push({ id: p.slice(pre.length), ...v });
    }
    l.cb(out);
  };
  let pending = false;
  const emit = () => {
    if (pending) return;
    pending = true;
    queueMicrotask(() => { pending = false; listeners.forEach(fire); });
  };
  const merge = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) {
      out[k] = v && typeof v === 'object' && !Array.isArray(v) && a[k] && typeof a[k] === 'object' && !Array.isArray(a[k])
        ? merge(a[k], v) : v;
    }
    return out;
  };
  const watch = (type, path, cb) => {
    const l = { type, path, cb };
    listeners.add(l);
    queueMicrotask(() => fire(l));
    return () => listeners.delete(l);
  };

  return {
    demo: true,
    onAuth(cb) {
      authCb = cb;
      queueMicrotask(() => cb(user));
      return () => {};
    },
    signIn(name) {
      user = { uid: 'demo-' + name, email: name + '@demo' };
      try { localStorage.setItem(USER_KEY, JSON.stringify(user)); } catch { /* ничего */ }
      authCb(user);
      return Promise.resolve();
    },
    signOut() {
      user = null;
      try { localStorage.removeItem(USER_KEY); } catch { /* ничего */ }
      authCb(null);
      return Promise.resolve();
    },
    watchCol: (path, cb) => watch('col', path, cb),
    watchDoc: (path, cb) => watch('doc', path, cb),
    newId() {
      return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    },
    save(path, obj, doMerge = true) {
      data[path] = doMerge ? merge(data[path] || {}, obj) : { ...obj };
      persist(); emit();
      return Promise.resolve();
    },
    remove(path) {
      delete data[path];
      persist(); emit();
      return Promise.resolve();
    },
  };
}
