const C='titan-v3';const CORE=['./','./index.html','./manifest.webmanifest','./apple-touch-icon.png','./icon-512.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(C).then(c=>c.addAll(CORE)));self.skipWaiting()});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==C).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener('fetch',e=>{const u=new URL(e.request.url);/* видео с камер не кэшируем: оно живое и быстро забьёт память телефона */
  if(e.request.method!=='GET'||/\.(m3u8|ts|m4s|aac|mp4)$/i.test(u.pathname)||u.pathname.includes('/live/')||u.pathname.includes('/seg/'))return;
  e.respondWith(fetch(e.request).then(r=>{const cp=r.clone();caches.open(C).then(c=>c.put(e.request,cp));return r}).catch(()=>caches.match(e.request).then(m=>m||caches.match('./index.html'))))});
