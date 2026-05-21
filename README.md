# 🎱 Billard Queue

Système de file d'attente en temps réel pour tables de billard en bar.

## Structure du projet

```
billard-queue/
├── src/
│   └── server.js       ← Le serveur (backend)
├── public/
│   ├── client.html     ← Page client (QR code)
│   ├── staff.html      ← Interface staff
│   └── qrcodes.html    ← Génération QR codes
└── package.json
```

## URLs une fois démarré

- Client (table 1) → http://localhost:3000/table/1
- Staff → http://localhost:3000/staff
- QR Codes → http://localhost:3000/qrcodes.html

## Modifier le nombre de tables de billard

Dans `src/server.js`, ligne avec `billiards: [`, ajoutez/retirez des entrées :
```js
{ id: 4, status: 'free', tableNum: null, sessionStart: null },
```
