// Rend la caisse installable comme une application.
// Aucune donnée de paiement n'est gardée sur le téléphone : tout passe par internet.
self.addEventListener('install', function () { self.skipWaiting(); });
self.addEventListener('activate', function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener('fetch', function (e) {
  if (e.request.mode !== 'navigate') return;
  e.respondWith(fetch(e.request).catch(function () {
    return new Response(
      '<!DOCTYPE html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
      '<title>Caisse | Corpus Clinic</title><body style="font-family:system-ui;background:#F5ECE2;color:#2A211B;display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px">' +
      '<div><h1 style="font-size:24px">Pas de connexion internet</h1><p>La caisse a besoin d\'internet. Vérifiez le Wi-Fi ou les données mobiles, puis rouvrez l\'application.</p></div>',
      { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  }));
});
