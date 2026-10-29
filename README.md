# PharmaClear

Prototype de lecture d'ordonnances. Il n'est **pas validé cliniquement** et ne
remplace pas un pharmacien ou un médecin. Une transcription estimée correcte
par le modèle n'est pas une information médicale vérifiée.

## Parcours

```text
Patient (PWA) -- HTTPS --> Node.js -- relais local --> relais C (file)
     |                         |                          |
     | photo gardée localement | API Meta                 | queue/
     | si hors ligne           |                          v
     +<------ résultat --------+<--- photo analysée -------+
```

Le navigateur conserve la photo dans IndexedDB jusqu'à l'envoi au relais et
reprend l'envoi au retour du réseau tant que l'application est ouverte. Après
réception du résultat, la photo est supprimée du téléphone et du relais. Les
résultats du relais sont supprimés après 24 h. Les photos en attente dans
`serveur_c/queue/` ne sont pas nettoyées.

## Démarrage local (environ 5 minutes)

Prérequis : Node.js 18+, npm, GCC, pthreads et `curl`.

1. Copie `.env.example` vers `.env`. Pour utiliser l'API réelle, renseigne
   `MODEL_API_KEY`; garde cette clé hors de Git.
2. À la racine du projet :

   ```sh
   npm install
   npm run dev
   ```

3. Dans un second terminal :

   ```sh
   cd serveur_c
   gcc -Wall -Wextra -O2 -pthread -o serveur serveur.c
   ./serveur
   ```

4. Ouvre `http://localhost:3000`. Le relais Node contacte le service C sur le
   port 8080.

Pour tester sans API, mets `PHARMA_MOCK=1` dans `.env`, puis redémarre Node.
Le résultat mock est fictif.

## HTTPS et accès réseau

Pour terminer TLS directement dans Node, configure `TLS_CERT_FILE` et
`TLS_KEY_FILE` avec les chemins de ton certificat et de sa clé privée. En
production, configure aussi `RELAY_TOKEN` dans `.env` et la même valeur comme
`PHARMA_TOKEN` pour le relais C. Le relais C doit être accessible seulement
depuis Node (par exemple `PHARMA_BIND=127.0.0.1`). Le serveur Node limite par
défaut les demandes d'analyse à 20 par minute et par adresse (`API_RATE_LIMIT`).

Un reverse proxy TLS peut aussi terminer HTTPS devant Node ; ne configure
`TRUST_PROXY` que pour l'adresse réelle du proxy. Pour un relais C distant,
configure `RELAY_URL` en HTTPS et protège le trajet réseau. La PWA et son cache
hors ligne nécessitent HTTPS, sauf sur `localhost`.

## Interactions : aucune donnée médicale inventée

La table [`data/interactions.json`](./data/interactions.json) est actuellement
vide : aucune interaction n'est confirmée par ce prototype. Chaque entrée doit
contenir les noms exacts des deux médicaments, la gravité, une source
bibliographique, son URL et sa date de vérification (`verified_on`). Elle doit
être relue par un pharmacien avant d'être ajoutée. Les noms de marque et
génériques ne sont pas assimilés automatiquement. Si une paire n'est pas dans
la table, l'interface indique « interaction non vérifiée » ; l'absence d'alerte
ne signifie jamais absence de risque. Aucun appel au modèle ne décide des
interactions.

Les explications en français, anglais et fon ne sont pas générées actuellement.
Elles ne devront être produites que pour des alertes documentées et afficher
« Traduction automatique, à vérifier ». Le contenu médical et les traductions
en fon doivent être relus par des personnes compétentes.

## Mesure avant démonstration

Évalue la lecture avec 15 à 20 ordonnances fictives et une transcription de
référence établie avant les essais. Rapporte séparément les noms corrects, les
cas signalés incertains et les noms faux présentés comme certains. Aucun
résultat de mesure n'est encore fourni par ce dépôt. Les statistiques non
sourcées sur les ordonnances manuscrites au Bénin ont été retirées.
