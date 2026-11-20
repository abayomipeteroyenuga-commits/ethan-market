const CACHE='ethan-market-v1.2-brand';
const SHELL=['/','/index.html','/styles.css','/app.js','/manifest.webmanifest','/assets/ethan-market-logo.png','/assets/ethan-market-icon-192.png','/assets/ethan-market-icon-512.png','/assets/favicon.png','/assets/apple-touch-icon.png'];
const NETWORK_FIRST=new Set(['/','/index.html','/styles.css','/app.js','/manifest.webmanifest']);
self.addEventListener('install',event=>event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(SHELL)).then(()=>self.skipWaiting())));
self.addEventListener('activate',event=>event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(key=>key!==CACHE).map(key=>caches.delete(key)))).then(()=>self.clients.claim())));
self.addEventListener('fetch',event=>{
  const request=event.request,url=new URL(request.url);
  if(request.method!=='GET'||url.origin!==self.location.origin||url.pathname.startsWith('/api/'))return;
  if(NETWORK_FIRST.has(url.pathname)){
    event.respondWith(fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response;}).catch(()=>caches.match(request).then(cached=>cached||caches.match('/index.html'))));
    return;
  }
  event.respondWith(caches.match(request).then(cached=>cached||fetch(request).then(response=>{if(response.ok)caches.open(CACHE).then(cache=>cache.put(request,response.clone()));return response;})));
});
