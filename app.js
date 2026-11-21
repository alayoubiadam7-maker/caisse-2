(function () {
  'use strict';

  // Collez ici l'adresse de l'application web Google Apps Script de la caisse (elle finit par /exec).
  var CAISSE_URL = 'https://script.google.com/macros/s/AKfycby9IQLKsY11rNszRqSYt9p8h1BTaztgHAQZ7qBhato37YSnR-h1CrCxQ5j8YEuanUou/exec';

  // La caisse refuse de s'afficher à l'intérieur d'un autre site (protection contre les pages pièges).
  if (window.top !== window.self) { document.documentElement.textContent = ''; return; }

  var $ = function (id) { return document.getElementById(id); };
  var etat = { jeton: '', role: '', soins: [], modes: [], periode: 'jour', date: aujourdhuiISO(), resume: null };
  var MOIS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  var MOIS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
  var MESSAGES = {
    code: 'Code incorrect. Vérifiez-le et réessayez.',
    bloque: 'Trop de codes incorrects. Réessayez dans 15 minutes.',
    session: 'Votre session a expiré. Reconnectez-vous.',
    montant: 'Montant invalide. Écrivez un nombre, par exemple 120 ou 80,500.',
    soin: 'Choisissez un soin.',
    mode: 'Choisissez un mode de paiement.',
    interdit: "Cette action n'est pas autorisée avec ce code.",
    introuvable: 'Ce paiement est introuvable. Actualisez la liste.',
    reseau: "Pas de connexion avec la caisse. Vérifiez internet et réessayez.",
    faceid: "Face ID n'a pas été reconnu. Réessayez.",
    appareils: "Le nombre maximum d'appareils Face ID est atteint.",
    defaut: "Une erreur est survenue. Réessayez dans un instant."
  };

  // ----- Outils -----
  function aujourdhuiISO() {
    try {
      var p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Tunis', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
      if (/^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
    } catch (e) {}
    var d = new Date();
    return d.getFullYear() + '-' + ('0' + (d.getMonth() + 1)).slice(-2) + '-' + ('0' + d.getDate()).slice(-2);
  }
  var fmt = new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 3 });
  function dt(n) { return fmt.format(n || 0) + ' DT'; }
  function el(tag, classe, texte) {
    var e = document.createElement(tag);
    if (classe) e.className = classe;
    if (texte !== undefined) e.textContent = texte;
    return e;
  }
  function vider(e) { while (e.firstChild) e.removeChild(e.firstChild); }
  function dire(id, texte, type) { var m = $(id); m.textContent = texte; m.className = 'message ' + (type || 'erreur'); m.hidden = !texte; }
  function cleAleatoire() {
    var a = new Uint8Array(16);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  function memoriser(cle, val) { try { if (val) sessionStorage.setItem(cle, val); else sessionStorage.removeItem(cle); } catch (e) {} }
  function relire(cle) { try { return sessionStorage.getItem(cle) || ''; } catch (e) { return ''; } }

  function appel(params) {
    if (!CAISSE_URL) return Promise.resolve({ ok: false, raison: 'config' });
    if (etat.jeton && params.action !== 'connexion') params.jeton = etat.jeton;
    return fetch(CAISSE_URL, { method: 'POST', body: new URLSearchParams(params) })
      .then(function (r) { return r.json(); })
      .catch(function () { return { ok: false, raison: 'reseau' }; })
      .then(function (r) {
        if (r && r.raison === 'session' && params.action !== 'connexion') { deconnecter(MESSAGES.session); }
        return r || { ok: false, raison: 'defaut' };
      });
  }
  function texteErreur(r) { return MESSAGES[r && r.raison] || MESSAGES.defaut; }

  // ----- Connexion -----
  if (!CAISSE_URL) dire('message-connexion', "L'application n'est pas encore reliée à la caisse Google. Ajoutez l'adresse dans app.js.");
  $('form-connexion').addEventListener('submit', function (e) {
    e.preventDefault();
    var code = $('code').value.trim();
    if (!code) return dire('message-connexion', "Écrivez votre code d'accès.");
    var b = $('bouton-connexion'); b.disabled = true; b.textContent = 'Connexion…';
    appel({ action: 'connexion', code: code }).then(function (r) {
      b.disabled = false; b.textContent = 'Se connecter';
      if (!r.ok) return dire('message-connexion', r.raison === 'config' ? "L'application n'est pas encore reliée à la caisse Google." : texteErreur(r));
      $('code').value = '';
      if (r.role === 'attente') return ouvrirFaceID(r);
      demarrer(r);
    });
  });

  // ----- Face ID (direction) -----
  // Le code direction ne suffit pas : le serveur exige ensuite la signature Face ID du téléphone.
  function versTampon(b64u) {
    var s = b64u.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '=';
    var bin = atob(s), a = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i);
    return a.buffer;
  }
  function versB64(buf) {
    var a = new Uint8Array(buf), s = '';
    for (var i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function faceIDPossible() { return !!(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create); }

  var attente = null;   // session direction en attente de Face ID
  function ouvrirFaceID(r) {
    attente = { jeton: r.jeton, etape: r.etape, defi: r.defi, appareils: r.appareils || [], soins: r.soins, modes: r.modes, recu: Date.now() };
    etat.jeton = r.jeton;
    dire('message-connexion', ''); dire('message-faceid', '');
    var premiere = r.etape === 'inscription';
    $('faceid-titre').textContent = premiere ? 'Activer Face ID' : 'Face ID';
    $('faceid-texte').textContent = premiere
      ? "Première connexion de la direction. Activez Face ID sur ce téléphone : ensuite, il faudra le code et votre visage pour voir les montants."
      : 'Confirmez avec votre visage pour ouvrir le tableau de bord.';
    $('bouton-faceid').textContent = premiere ? 'Activer Face ID' : 'Déverrouiller avec Face ID';
    $('ecran-connexion').hidden = true; $('ecran-faceid').hidden = false;
    if (!faceIDPossible()) dire('message-faceid', "Ce navigateur ne permet pas Face ID. Ouvrez la caisse sur votre téléphone, dans Safari ou Chrome à jour.");
    $('bouton-faceid').focus();
  }
  // Un défi neuf, si le précédent a servi ou date de plus de 4 minutes.
  function defiFrais(etatFaceID) {
    if (etatFaceID.defi && Date.now() - etatFaceID.recu < 240000) return Promise.resolve(etatFaceID);
    return appel({ action: 'faceid-options' }).then(function (o) {
      if (!o.ok) throw o;
      etatFaceID.defi = o.defi; etatFaceID.appareils = o.appareils || []; etatFaceID.recu = Date.now();
      return etatFaceID;
    });
  }
  function creerCle(defi, existants) {
    var id = new Uint8Array(16); window.crypto.getRandomValues(id);
    return navigator.credentials.create({ publicKey: {
      challenge: versTampon(defi),
      rp: { name: 'Caisse Corpus Clinic' },
      user: { id: id.buffer, name: 'direction', displayName: 'Direction Corpus Clinic' },
      pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
      authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
      excludeCredentials: existants.map(function (x) { return { type: 'public-key', id: versTampon(x) }; }),
      attestation: 'none', timeout: 60000
    } }).then(function (c) {
      return { action: 'faceid-inscrire', donneesClient: versB64(c.response.clientDataJSON), attestation: versB64(c.response.attestationObject) };
    });
  }
  function signer(defi, existants) {
    return navigator.credentials.get({ publicKey: {
      challenge: versTampon(defi),
      allowCredentials: existants.map(function (x) { return { type: 'public-key', id: versTampon(x) }; }),
      userVerification: 'required', timeout: 60000
    } }).then(function (c) {
      return { action: 'faceid-verifier', id: versB64(c.rawId), donneesClient: versB64(c.response.clientDataJSON),
               authData: versB64(c.response.authenticatorData), signature: versB64(c.response.signature) };
    });
  }
  function erreurNavigateur(e) {
    if (e && e.raison) return texteErreur(e);
    if (e && e.name === 'InvalidStateError') return 'Cet appareil est déjà enregistré pour Face ID.';
    if (e && e.name === 'NotAllowedError') return 'Face ID annulé ou non reconnu. Touchez le bouton pour réessayer.';
    return "Face ID n'a pas pu être utilisé sur cet appareil. Réessayez.";
  }
  $('bouton-faceid').addEventListener('click', function () {
    if (!attente || !faceIDPossible()) return;
    var b = $('bouton-faceid'); b.disabled = true; dire('message-faceid', '');
    var a = attente, etape = a.etape;
    defiFrais(a).then(function (x) {
      var defi = x.defi; x.defi = '';          // chaque défi ne sert qu'une fois
      return etape === 'inscription' ? creerCle(defi, x.appareils) : signer(defi, x.appareils);
    }).then(function (params) {
      return appel(params);
    }).then(function (r) {
      b.disabled = false;
      if (!r.ok) throw r;
      var s = { jeton: a.jeton, role: 'direction', soins: a.soins, modes: a.modes };
      attente = null;
      $('ecran-faceid').hidden = true;
      demarrer(s);
      if (etape === 'inscription') dire('message-tableau', 'Face ID est activé. Il sera demandé à chaque connexion de la direction.', 'succes');
    }).catch(function (e) {
      b.disabled = false;
      if (!attente) return;
      dire('message-faceid', erreurNavigateur(e));
      a.defi = ''; defiFrais(a).catch(function () {});   // prépare le prochain essai
    });
  });
  $('faceid-retour').addEventListener('click', function () { attente = null; deconnecter(''); });

  function demarrer(r) {
    etat.jeton = r.jeton; etat.role = r.role; etat.soins = r.soins || []; etat.modes = r.modes || [];
    memoriser('caisse-session', JSON.stringify({ jeton: r.jeton, role: r.role, soins: etat.soins, modes: etat.modes }));
    dire('message-connexion', '');
    $('ecran-connexion').hidden = true; $('ecran-app').hidden = false;
    $('role').textContent = r.role === 'direction' ? 'Direction' : 'Secrétaire';
    construireChoix('choix-soin', 'soin', etat.soins);
    construireChoix('choix-mode', 'mode', etat.modes);
    $('onglets').hidden = r.role !== 'direction';
    $('bloc-securite').hidden = r.role !== 'direction';
    afficherVue(r.role === 'direction' ? 'tableau' : 'saisie');
    if (r.role === 'direction') chargerSecurite();
  }

  // ----- Carte Face ID : nombre d'appareils, ajout d'un appareil -----
  var ajout = null;
  function chargerSecurite() {
    appel({ action: 'faceid-options' }).then(function (o) {
      if (!o.ok) return;
      ajout = { defi: o.defi, appareils: o.appareils || [], recu: Date.now() };
      var n = ajout.appareils.length;
      $('texte-securite').textContent = n
        ? 'Face ID est activé sur ' + n + (n > 1 ? ' appareils' : ' appareil') + '. Sans lui, le code direction seul ne permet pas de voir les montants.'
        : "Face ID n'est pas encore activé.";
      $('ajouter-appareil').hidden = !faceIDPossible();
    });
  }
  $('ajouter-appareil').addEventListener('click', function () {
    if (!ajout) return;
    var b = $('ajouter-appareil'); b.disabled = true; dire('message-securite', '');
    defiFrais(ajout).then(function (x) {
      var defi = x.defi; x.defi = '';
      return creerCle(defi, x.appareils);
    }).then(appel).then(function (r) {
      b.disabled = false;
      if (!r.ok) throw r;
      dire('message-securite', 'Cet appareil est ajouté. Il pourra ouvrir la caisse avec Face ID.', 'succes');
      chargerSecurite();
    }).catch(function (e) {
      b.disabled = false;
      dire('message-securite', erreurNavigateur(e));
      ajout.defi = ''; 
    });
  });

  function deconnecter(message) {
    if (etat.jeton && !message) appel({ action: 'deconnexion' });
    etat.jeton = ''; etat.role = ''; etat.resume = null; attente = null;
    memoriser('caisse-session', '');
    $('ecran-app').hidden = true; $('ecran-faceid').hidden = true; $('ecran-connexion').hidden = false;
    vider($('liste-jour')); vider($('detail'));
    dire('message-connexion', message || '', message ? 'erreur' : '');
    $('code').focus();
  }
  $('deconnexion').addEventListener('click', function () { deconnecter(''); });

  // Reprend la session ouverte dans cet onglet (elle se ferme avec l'onglet).
  (function () {
    try { var s = JSON.parse(relire('caisse-session') || 'null'); if (s && s.jeton && (s.role === 'direction' || s.role === 'secretaire')) demarrer(s); } catch (e) {}
  })();

  // ----- Navigation -----
  function afficherVue(vue) {
    $('vue-saisie').hidden = vue !== 'saisie';
    $('vue-tableau').hidden = vue !== 'tableau';
    Array.prototype.forEach.call(document.querySelectorAll('.onglet'), function (o) { o.setAttribute('aria-pressed', String(o.getAttribute('data-vue') === vue)); });
    if (vue === 'saisie') { chargerJour(); setTimeout(function () { $('montant').focus(); }, 50); }
    else chargerResume();
  }
  Array.prototype.forEach.call(document.querySelectorAll('.onglet'), function (o) {
    o.addEventListener('click', function () { afficherVue(o.getAttribute('data-vue')); });
  });

  // ----- Saisie d'un paiement -----
  function construireChoix(id, nom, valeurs) {
    var c = $(id); vider(c);
    valeurs.forEach(function (v) {
      var l = el('label'), i = el('input'), s = el('span', '', v);
      i.type = 'radio'; i.name = nom; i.value = v;
      l.appendChild(i); l.appendChild(s); c.appendChild(l);
    });
  }
  function choisi(nom) { var i = document.querySelector('input[name="' + nom + '"]:checked'); return i ? i.value : ''; }

  var cleEnvoi = '';
  $('form-paiement').addEventListener('submit', function (e) {
    e.preventDefault();
    var montant = $('montant').value.replace(/\s/g, '').replace(',', '.');
    if (!/^\d{1,6}(\.\d{1,3})?$/.test(montant) || Number(montant) <= 0) return dire('message-paiement', MESSAGES.montant);
    var soin = choisi('soin'), mode = choisi('mode');
    if (!soin) return dire('message-paiement', MESSAGES.soin);
    if (!mode) return dire('message-paiement', MESSAGES.mode);
    // Même clé si on renvoie le même formulaire : le paiement n'est jamais compté deux fois.
    cleEnvoi = cleEnvoi || cleAleatoire();
    var b = $('bouton-enregistrer'); b.disabled = true; b.textContent = 'Enregistrement…';
    appel({ action: 'ajouter', montant: montant, soin: soin, mode: mode, cle: cleEnvoi }).then(function (r) {
      b.disabled = false; b.textContent = 'Enregistrer le paiement';
      if (!r.ok) return dire('message-paiement', texteErreur(r));
      cleEnvoi = '';
      $('form-paiement').reset();
      dire('message-paiement', 'Enregistré : ' + dt(r.paiement.montant) + ', ' + r.paiement.soin + ', ' + r.paiement.mode.toLowerCase() + '.', 'succes');
      chargerJour();
      $('montant').focus();
    });
  });
  // Toute modification du formulaire en fait un nouveau paiement.
  $('form-paiement').addEventListener('input', function () { cleEnvoi = ''; });
  $('form-paiement').addEventListener('change', function () { cleEnvoi = ''; });

  function chargerJour() {
    var ul = $('liste-jour');
    appel({ action: 'aujourdhui' }).then(function (r) {
      vider(ul);
      if (!r.ok) { ul.appendChild(el('li', 'vide', texteErreur(r))); return; }
      if (!r.paiements.length) { ul.appendChild(el('li', 'vide', "Aucun paiement enregistré aujourd'hui.")); return; }
      r.paiements.forEach(function (p) { ul.appendChild(lignePaiement(p)); });
    });
  }
  $('actualiser-jour').addEventListener('click', chargerJour);

  function lignePaiement(p) {
    var li = el('li', p.annule ? 'annule' : '');
    li.appendChild(el('span', 'heure', p.quand.slice(11, 16)));
    var q = el('div', 'quoi');
    q.appendChild(el('strong', '', dt(p.montant)));
    q.appendChild(el('span', '', p.soin + ' · ' + p.mode));
    li.appendChild(q);
    if (p.annule) li.appendChild(el('span', 'etiquette-annule', 'Annulé'));
    else {
      var b = el('button', 'bouton-annuler', 'Annuler'); b.type = 'button';
      b.setAttribute('aria-label', 'Annuler le paiement de ' + dt(p.montant) + ' à ' + p.quand.slice(11, 16));
      b.addEventListener('click', function () { demanderAnnulation(p, b); });
      li.appendChild(b);
    }
    return li;
  }

  // ----- Annulation -----
  var aAnnuler = null, retourFocus = null;
  function demanderAnnulation(p, bouton) {
    aAnnuler = p; retourFocus = bouton;
    $('resume-annulation').textContent = dt(p.montant) + ', ' + p.soin + ', ' + p.mode.toLowerCase() + ', le ' + p.jour.split('-').reverse().join('/') + ' à ' + p.quand.slice(11, 16) + '.';
    $('motif').value = '';
    $('voile-annulation').hidden = false;
    $('motif').focus();
  }
  function fermerAnnulation() { $('voile-annulation').hidden = true; aAnnuler = null; if (retourFocus) retourFocus.focus(); }
  $('garder').addEventListener('click', fermerAnnulation);
  $('voile-annulation').addEventListener('keydown', function (e) { if (e.key === 'Escape') fermerAnnulation(); });
  $('form-annulation').addEventListener('submit', function (e) {
    e.preventDefault();
    if (!aAnnuler) return;
    var b = $('confirmer-annulation'); b.disabled = true;
    appel({ action: 'annuler', id: aAnnuler.id, motif: $('motif').value }).then(function (r) {
      b.disabled = false;
      var vueSaisie = !$('vue-saisie').hidden;
      fermerAnnulation();
      if (!r.ok) return dire(vueSaisie ? 'message-paiement' : 'message-tableau', texteErreur(r));
      if (vueSaisie) { dire('message-paiement', 'Paiement annulé.', 'succes'); chargerJour(); }
      else chargerResume();
    });
  });

  // ----- Tableau de bord (direction) -----
  Array.prototype.forEach.call(document.querySelectorAll('.segment[data-periode]'), function (s) {
    s.addEventListener('click', function () { etat.periode = s.getAttribute('data-periode'); chargerResume(); });
  });
  function decaler(sens) {
    var p = etat.date.split('-').map(Number), d;
    if (etat.periode === 'jour') d = new Date(Date.UTC(p[0], p[1] - 1, p[2] + sens));
    else if (etat.periode === 'mois') d = new Date(Date.UTC(p[0], p[1] - 1 + sens, 1));
    else d = new Date(Date.UTC(p[0] + sens, 0, 1));
    etat.date = d.toISOString().slice(0, 10);
    chargerResume();
  }
  $('precedent').addEventListener('click', function () { decaler(-1); });
  $('suivant').addEventListener('click', function () { decaler(1); });
  $('aujourdhui').addEventListener('click', function () { etat.date = aujourdhuiISO(); chargerResume(); });

  function libellePeriode() {
    var p = etat.date.split('-').map(Number);
    if (etat.periode === 'jour') {
      var d = new Date(Date.UTC(p[0], p[1] - 1, p[2]));
      var j = new Intl.DateTimeFormat('fr-FR', { weekday: 'long', timeZone: 'UTC' }).format(d);
      return j.charAt(0).toUpperCase() + j.slice(1) + ' ' + p[2] + ' ' + MOIS_LONG[p[1] - 1] + ' ' + p[0];
    }
    if (etat.periode === 'mois') return MOIS_LONG[p[1] - 1].charAt(0).toUpperCase() + MOIS_LONG[p[1] - 1].slice(1) + ' ' + p[0];
    return String(p[0]);
  }

  var demandeResume = 0;
  function chargerResume() {
    Array.prototype.forEach.call(document.querySelectorAll('.segment[data-periode]'), function (s) { s.setAttribute('aria-pressed', String(s.getAttribute('data-periode') === etat.periode)); });
    $('libelle-periode').textContent = libellePeriode();
    if (etat.periode !== 'annee') { $('bloc-mois').hidden = true; $('bloc-croise').hidden = true; }
    $('suivant').disabled = etat.date >= aujourdhuiISO() && etat.periode === 'jour';
    dire('message-tableau', '');
    var n = ++demandeResume;
    appel({ action: 'resume', periode: etat.periode, date: etat.date }).then(function (r) {
      if (n !== demandeResume) return;
      if (!r.ok) { dire('message-tableau', texteErreur(r)); return; }
      etat.resume = r;
      $('total').textContent = dt(r.total);
      $('nombre').textContent = String(r.nombre);
      $('moyen').textContent = r.nombre ? dt(Math.round(r.total / r.nombre * 1000) / 1000) : '–';
      $('annules').textContent = String(r.annules);
      dessinerSerie(r);
      dessinerBarres('par-mode', r.parMode, r.total);
      dessinerBarres('par-soin', r.parSoin, r.total);
      dessinerDetail(r);
      dessinerMois(r);
    });
  }

  // ----- Année : chaque mois séparé, pour comparer -----
  var croise = 'soin';
  function dessinerMois(r) {
    var annee = r.periode === 'annee';
    $('bloc-mois').hidden = !annee; $('bloc-croise').hidden = !annee;
    if (!annee) return;
    var an = etat.date.slice(0, 4), auj = aujourdhuiISO();
    var parMois = {}; (r.mois || []).forEach(function (m) { parMois[m.mois] = m; });
    var corps = $('mois-corps'), pied = $('mois-pied'); vider(corps); vider(pied);
    var precedent = null, totN = 0, totA = 0;
    for (var i = 1; i <= 12; i++) {
      var k = ('0' + i).slice(-2), m = parMois[k] || { total: 0, nombre: 0, annules: 0 };
      var futur = an + '-' + k > auj.slice(0, 7);
      var tr = el('tr', futur ? 'futur' : '');
      var td = el('td');
      if (futur) td.textContent = MOIS_LONG[i - 1];
      else {
        var b = el('button', 'lien-mois', MOIS_LONG[i - 1]); b.type = 'button';
        b.setAttribute('aria-label', 'Ouvrir ' + MOIS_LONG[i - 1] + ' ' + an);
        (function (cle) { b.addEventListener('click', function () { etat.periode = 'mois'; etat.date = an + '-' + cle + '-01'; chargerResume(); window.scrollTo(0, 0); }); })(k);
        td.appendChild(b);
      }
      tr.appendChild(td);
      tr.appendChild(el('td', 'nombre', futur ? '–' : String(m.nombre)));
      tr.appendChild(el('td', 'nombre', futur ? '–' : dt(m.total)));
      tr.appendChild(el('td', 'nombre', futur || !m.nombre ? '–' : dt(Math.round(m.total / m.nombre * 1000) / 1000)));
      var evo = '–';
      if (!futur && precedent !== null && precedent > 0) {
        var pc = Math.round((m.total - precedent) / precedent * 100);
        evo = pc > 0 ? '▲ +' + pc + ' %' : pc < 0 ? '▼ −' + Math.abs(pc) + ' %' : '= 0 %';
      }
      tr.appendChild(el('td', 'nombre evolution', evo));
      tr.appendChild(el('td', 'nombre', futur ? '–' : (r.total ? Math.round(m.total / r.total * 100) : 0) + ' %'));
      tr.appendChild(el('td', 'nombre', futur ? '–' : String(m.annules)));
      corps.appendChild(tr);
      if (!futur) { precedent = m.total; totN += m.nombre; totA += m.annules; }
    }
    var tp = el('tr');
    [['Année ' + an, ''], [String(totN), 'nombre'], [dt(r.total), 'nombre'], [totN ? dt(Math.round(r.total / totN * 1000) / 1000) : '–', 'nombre'], ['', ''], ['100 %', 'nombre'], [String(totA), 'nombre']]
      .forEach(function (c) { tp.appendChild(el('td', c[1], c[0])); });
    pied.appendChild(tp);
    dessinerCroise(r);
  }

  function dessinerCroise(r) {
    var cle = croise === 'soin' ? 'parSoin' : 'parMode';
    var noms = croise === 'soin' ? etat.soins.slice() : etat.modes.slice();
    $('titre-croise').textContent = croise === 'soin' ? 'Chaque soin, mois par mois' : 'Chaque mode de paiement, mois par mois';
    Array.prototype.forEach.call(document.querySelectorAll('.segment.croise'), function (b) { b.setAttribute('aria-pressed', String(b.getAttribute('data-croise') === croise)); });
    var parMois = {}; (r.mois || []).forEach(function (m) { parMois[m.mois] = m[cle] || {}; });
    // Valeurs déjà présentes dans les données mais absentes de la liste actuelle.
    Object.keys(parMois).forEach(function (k) { Object.keys(parMois[k]).forEach(function (n) { if (noms.indexOf(n) === -1) noms.push(n); }); });
    var max = 0;
    Object.keys(parMois).forEach(function (k) { Object.keys(parMois[k]).forEach(function (n) { max = Math.max(max, parMois[k][n]); }); });
    var tete = $('croise-tete'), corps = $('croise-corps'); vider(tete); vider(corps);
    var trh = el('tr'); trh.appendChild(el('th', '', croise === 'soin' ? 'Soin' : 'Mode'));
    MOIS.forEach(function (m) { var th = el('th', '', m); th.scope = 'col'; trh.appendChild(th); });
    trh.appendChild(el('th', '', 'Année'));
    Array.prototype.forEach.call(trh.children, function (th) { th.scope = 'col'; });
    tete.appendChild(trh);
    var totMois = {};
    noms.forEach(function (n) {
      var tr = el('tr'), tot = 0, th = el('td', '', n);
      tr.appendChild(th);
      for (var i = 1; i <= 12; i++) {
        var k = ('0' + i).slice(-2), v = (parMois[k] || {})[n] || 0;
        tot += v; totMois[k] = (totMois[k] || 0) + v;
        var td = el('td', 'case' + (v ? '' : ' zero'), v ? fmt.format(v) : '–');
        if (v && max) td.style.backgroundColor = 'rgba(138, 85, 34, ' + (0.08 + 0.47 * v / max).toFixed(3) + ')';
        td.title = n + ', ' + MOIS_LONG[i - 1] + ' : ' + dt(v);
        tr.appendChild(td);
      }
      tr.appendChild(el('td', 'nombre', dt(tot)));
      corps.appendChild(tr);
    });
    var trt = el('tr', 'total-ligne'); trt.appendChild(el('td', '', 'Total'));
    for (var i = 1; i <= 12; i++) { var k = ('0' + i).slice(-2); trt.appendChild(el('td', '', totMois[k] ? fmt.format(totMois[k]) : '–')); }
    trt.appendChild(el('td', 'nombre', dt(r.total)));
    corps.appendChild(trt);
  }
  Array.prototype.forEach.call(document.querySelectorAll('.segment.croise'), function (b) {
    b.addEventListener('click', function () { croise = b.getAttribute('data-croise'); if (etat.resume) dessinerCroise(etat.resume); });
  });

  function dessinerSerie(r) {
    var g = $('graphique'); vider(g);
    var p = etat.date.split('-').map(Number), cles = [], libelles = [], titre;
    var serie = {}; Object.keys(r.serie).forEach(function (k) { serie[k] = r.serie[k]; });
    if (r.periode === 'jour') {
      for (var h = 8; h <= 20; h++) { cles.push(('0' + h).slice(-2)); libelles.push(h + 'h'); }
      titre = 'Encaissements par heure';
    } else if (r.periode === 'mois') {
      var nb = new Date(Date.UTC(p[0], p[1], 0)).getUTCDate();
      for (var j = 1; j <= nb; j++) { cles.push(('0' + j).slice(-2)); libelles.push(String(j)); }
      titre = 'Encaissements par jour';
    } else {
      for (var m = 1; m <= 12; m++) { cles.push(('0' + m).slice(-2)); libelles.push(MOIS[m - 1]); }
      titre = 'Encaissements par mois';
    }
    // Paiements saisis en dehors des heures prévues : ajoutés à la première ou dernière heure.
    if (r.periode === 'jour') Object.keys(r.serie).forEach(function (k) {
      if (cles.indexOf(k) === -1) { var c = k < '08' ? '08' : '20'; serie[c] = (serie[c] || 0) + serie[k]; }
    });
    $('titre-serie').textContent = titre;
    var max = 0; cles.forEach(function (k) { max = Math.max(max, serie[k] || 0); });
    g.setAttribute('aria-label', titre + '. Total ' + dt(r.total) + '. Le détail est dans le tableau plus bas.');
    if (!max) { g.appendChild(el('p', 'graphique-vide', 'Aucun encaissement sur cette période.')); return; }
    var hauteurUtile = g.clientHeight - 26 - 20;
    var lm = el('div', 'ligne-max'); lm.style.bottom = (26 + hauteurUtile) + 'px';
    lm.appendChild(el('span', '', dt(max))); g.appendChild(lm);
    var pas = cles.length > 20 ? 5 : 1;
    cles.forEach(function (k, i) {
      var v = serie[k] || 0, col = el('div', 'colonne'), barre = el('div', 'valeur');
      barre.style.height = Math.round(v / max * hauteurUtile) + 'px';
      col.appendChild(barre);
      if (i === 0 || (i + 1) % pas === 0) col.appendChild(el('span', 'graduation', libelles[i]));
      var texte = (r.periode === 'jour' ? libelles[i] : r.periode === 'mois' ? libelles[i] + ' ' + MOIS[p[1] - 1] : MOIS_LONG[i]) + ' : ' + dt(v);
      col.tabIndex = v ? 0 : -1;
      col.setAttribute('aria-label', texte);
      function montrer() {
        var b = col.getBoundingClientRect(), t = $('infobulle');
        t.textContent = texte; t.hidden = false;
        t.style.left = Math.min(Math.max(b.left + b.width / 2, 70), window.innerWidth - 70) + 'px';
        t.style.top = (b.bottom - 26 - Math.max(barre.offsetHeight, 8)) + 'px';
      }
      function cacher() { $('infobulle').hidden = true; }
      col.addEventListener('mouseenter', montrer); col.addEventListener('focus', montrer);
      col.addEventListener('mouseleave', cacher); col.addEventListener('blur', cacher);
      g.appendChild(col);
    });
  }
  window.addEventListener('scroll', function () { $('infobulle').hidden = true; }, { passive: true });

  function dessinerBarres(id, donnees, total) {
    var ul = $(id); vider(ul);
    var noms = Object.keys(donnees).sort(function (a, b) { return donnees[b] - donnees[a]; });
    if (!noms.length) { ul.appendChild(el('li', 'vide', 'Aucun encaissement.')); return; }
    var max = donnees[noms[0]];
    noms.forEach(function (nom) {
      var li = el('li'), piste = el('div', 'piste'), rempli = el('div', 'rempli');
      li.appendChild(el('span', 'nom', nom));
      rempli.style.width = Math.max(2, Math.round(donnees[nom] / max * 100)) + '%';
      piste.appendChild(rempli); li.appendChild(piste);
      var part = total ? Math.round(donnees[nom] / total * 100) : 0;
      li.appendChild(el('span', 'montant', dt(donnees[nom]) + ' · ' + part + ' %'));
      ul.appendChild(li);
    });
  }

  function dessinerDetail(r) {
    var tb = $('detail'); vider(tb);
    $('bloc-detail').hidden = r.periode === 'annee';
    if (r.periode === 'annee') return;
    if (!r.paiements.length) {
      var tr0 = el('tr'), td0 = el('td', 'vide', 'Aucun paiement sur cette période.'); td0.colSpan = 6; tr0.appendChild(td0); tb.appendChild(tr0); return;
    }
    r.paiements.forEach(function (p) {
      var tr = el('tr', p.annule ? 'annule' : '');
      tr.appendChild(el('td', '', p.jour.split('-').reverse().join('/') + ' ' + p.quand.slice(11, 16)));
      tr.appendChild(el('td', '', p.soin));
      tr.appendChild(el('td', '', p.mode));
      tr.appendChild(el('td', '', p.par));
      tr.appendChild(el('td', 'nombre', dt(p.montant)));
      var td = el('td');
      if (p.annule) { var s = el('span', 'etiquette-annule', 'Annulé'); if (p.motif) s.title = p.motif.replace(/^'/, ''); td.appendChild(s); }
      else { var b = el('button', 'bouton-annuler', 'Annuler'); b.type = 'button'; b.addEventListener('click', function () { demanderAnnulation(p, b); }); td.appendChild(b); }
      tr.appendChild(td); tb.appendChild(tr);
    });
  }

  // ----- Export CSV (ouvrable dans Excel) -----
  function celluleCSV(v) {
    var s = String(v == null ? '' : v);
    if (/^[=+\-@]/.test(s)) s = "'" + s;              // empêche Excel d'y voir une formule
    return '"' + s.replace(/"/g, '""') + '"';
  }
  $('exporter').addEventListener('click', function () {
    var p = etat.date.split('-'), debut, fin;
    if (etat.periode === 'jour') { debut = fin = etat.date; }
    else if (etat.periode === 'mois') { debut = p[0] + '-' + p[1] + '-01'; fin = p[0] + '-' + p[1] + '-31'; }
    else { debut = p[0] + '-01-01'; fin = p[0] + '-12-31'; }
    var b = $('exporter'); b.disabled = true;
    appel({ action: 'exporter', debut: debut, fin: fin }).then(function (r) {
      b.disabled = false;
      if (!r.ok) return dire('message-tableau', texteErreur(r));
      var lignes = [['ID', 'Date', 'Heure', 'Montant (DT)', 'Soin', 'Mode de paiement', 'Saisi par', 'Statut', 'Motif annulation']];
      r.paiements.forEach(function (x) {
        lignes.push([x.id, x.jour, x.quand.slice(11, 16), String(x.montant).replace('.', ','), x.soin, x.mode, x.par, x.annule ? 'Annulé' : 'Validé', x.motif.replace(/^'/, '')]);
      });
      var csv = '﻿' + lignes.map(function (l) { return l.map(celluleCSV).join(';'); }).join('\r\n');
      var a = document.createElement('a');
      a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
      a.download = 'caisse-corpus-clinic-' + debut + (fin !== debut ? '_' + fin : '') + '.csv';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 2000);
    });
  });

  // ----- Installation comme application (sans App Store ni Play Store) -----
  if ('serviceWorker' in navigator && location.protocol === 'https:') {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
  var installable = null;
  var dejaInstallee = (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone === true;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault(); installable = e;
    if (!dejaInstallee) $('bloc-installer').hidden = false;
  });
  $('installer').addEventListener('click', function () {
    if (!installable) return;
    installable.prompt();
    installable.userChoice.then(function () { installable = null; $('bloc-installer').hidden = true; });
  });
  window.addEventListener('appinstalled', function () { $('bloc-installer').hidden = true; });
  var ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (ios && !dejaInstallee) $('astuce-ios').hidden = false;

  window.addEventListener('resize', function () { if (etat.resume && !$('vue-tableau').hidden) dessinerSerie(etat.resume); });
})();
