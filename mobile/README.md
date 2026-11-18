# TypeR Studio, iPhone, iPad et Android

L'app mobile de TypeR Studio. Elle embarque le même code que la version web (`web/`), avec son
interface tactile, dans une vraie app ([Capacitor](https://capacitorjs.com) 8) : hors-ligne dès le
premier lancement, plein écran, et surtout les fichiers. Un navigateur de téléphone ne donne que des
copies ; l'app ouvre les fichiers là où ils sont (Fichiers, iCloud Drive, Google Drive, clé USB) et
garde le droit d'écrire dessus : Enregistrer réécrit le PSD d'origine, comme sur ordinateur.

## Comment c'est fait

- `scripts/build-content.js` copie les fichiers du site dans `www/` (les mêmes que l'app de bureau,
  choisis par git : voir `desktop/scripts/site-files.js`).
- `web/mobile.js` et `web/mobile.css` ne sont chargés que dans l'app (`web/index.html`). `mobile.js`
  donne à la page les sélecteurs et les « handles » qu'a le navigateur d'un ordinateur
  (`showOpenFilePicker`, `showSaveFilePicker`, `showDirectoryPicker`) : tout ce qui marche avec eux
  sur ordinateur marche ici, sans autre code (Enregistrer sur place, Ouvrir un fichier récent,
  Ouvrir des pages depuis un dossier, Enregistrer par lot).
- Le plugin natif `TypeRFiles` fait le travail derrière : `ios/App/App/TypeRFilesPlugin.swift` et
  `android/app/src/main/java/fr/scanr/typerstudio/TypeRFilesPlugin.java`. La page ne reçoit jamais
  de chemin, seulement un jeton pour ce que l'utilisateur a choisi. Les deux côtés répondent aux
  mêmes méthodes : en changer une, c'est changer les deux.
- Identifiant de l'app : `fr.scanr.typerstudio` (iOS et Android). À ne plus changer après une
  première publication : il identifie l'app et ses données.

## Au quotidien

```sh
npm install          # une seule fois
npm run sync         # copie web/ dans www/, puis dans les deux projets natifs
npm run ios          # la même chose, puis ouvre Xcode
npm run android      # la même chose, puis ouvre Android Studio
npm run icons        # redessine icônes et écrans de lancement depuis assets/brand/
```

Sans passer par Xcode ni Android Studio :

```sh
# iOS, pour le simulateur
cd ios/App && xcodebuild -project App.xcodeproj -scheme App -configuration Debug -sdk iphonesimulator \
  -destination 'generic/platform=iOS Simulator' -derivedDataPath ../build CODE_SIGNING_ALLOWED=NO build

# Android : Gradle 8 ne tourne pas avec Java 26, il lui faut le 21
cd android && JAVA_HOME=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home ./gradlew assembleDebug
```

Un simulateur iOS et un émulateur Android allumés prennent plusieurs Go de mémoire, donc de disque
(swap) : les éteindre dès qu'on a fini.

## Ce qui change sur un téléphone

L'app n'est pas la version ordinateur dans un petit écran : ce qui parle de souris, de clavier, de
navigateur ou de Photoshop installé à côté n'y est pas dit, ou est dit autrement.

- Côté page, deux conditions : `Shell.touch` (un écran tactile, app ou site) et `IN_APP`
  (`window.TypeRMobile`, l'app seulement). La première choisit « toucher » plutôt que « cliquer » et
  retire ce qui n'a pas de sens au doigt (molette, raccourcis, tutoriels à la souris) ; la seconde
  dit « l'app » et « cet appareil » plutôt que « ce navigateur » et « cet ordinateur », et retire les
  téléchargements et le retour au site.
- L'assistant de démarrage (`web/onboarding.js`) a ses étapes pour le tactile : les styles
  s'importent d'un fichier exporté sur ordinateur, les polices s'ajoutent depuis Font FindeR ou des
  fichiers, et la fin montre les gestes puis propose la page d'entraînement.
- Les polices : un téléphone ne liste pas les siennes. Plus → Polices (`fontsBox` dans
  `web/app.js`) cherche dans Font FindeR, ajoute des fichiers et montre ce que l'app garde.
- Sur iPhone tenu droit, la barre du haut et les onglets sont ceux du système
  (`ios/App/App/TypeRChromePlugin.swift`) : Liquid Glass à partir d'iOS 26. `web/touch.js` dit ce
  qu'ils montrent (`barsState`) et reçoit ce qui est touché (`barsDo`) ; `web/mobile.js` fait le
  lien, leur laisse la place (`--bars-t`, `--bars-b`) et les efface tant qu'une fenêtre, un menu ou
  le voile d'attente de la page couvre l'écran. Couché, sur iPad et sur Android, les barres restent
  celles de la page.

- Un script arrive comme un fichier : l'app se déclare pour les documents Word (.docx) et le texte
  brut (`Info.plist`, `AndroidManifest.xml`), donc elle est proposée dans la fenêtre de partage
  d'une autre app (Google Docs → Envoyer une copie → Word). Le fichier reçu passe par
  `openFiles` comme une page, et `importScriptFile` (`web/app.js`) en fait un onglet du script.
  Sur Android, du texte partagé sans fichier devient un script aussi.

- Le script, sur écran tactile (app et site), a sa propre vue dans `web/touch.js` (« the script ») :
  une rangée par ligne, la ligne en cours marquée, les marqueurs « Page N » en titres, chaque script
  en pastille, et un écran vide qui propose Coller, Importer, Écrire. Le panneau TypeR garde le
  script et fait le travail : ses rangées sont lues (numéros, marqueurs, balises) et ses boutons
  pressés. Changer la structure du panneau (`.text-line`, `.tab-bar-tab`, `.text-area`) demande
  donc de revoir cette vue. À partir de 200 lignes, le panneau ne garde que les rangées visibles :
  sur écran tactile son bloc de script est rendu très haut (`web/panel/index.html`) pour qu'elles
  y soient toutes.
- Le chapitre revient au lancement suivant, comme les documents ouverts : les accès à ses pages
  sont gardés (`keepChapter`, `restoreChapter` dans `web/app.js`) et relus une fois les documents
  revenus ; le script, toujours lié à ses pages, continue. Vaut aussi pour le site quand le
  navigateur laisse encore lire les fichiers. Si les pages ne reviennent pas, le script est délié
  et l'app le dit une fois, au lieu de l'erreur du panneau et de son chemin `web-file://`.
  Vérifié dans Chrome sans écran avec un faux sélecteur de fichiers, pas sur un appareil.
- Sur écran tactile, une page PSD du chapitre s'enregistre sur son fichier quand on la quitte pour
  une autre (flèches, liste des pages, ligne du script), puis se ferme comme une page quittée sans
  changement (`savePageLeft` dans `web/app.js`). Une page PNG ou JPEG, qui demanderait où
  l'enregistrer, reste ouverte avec ses changements. Vérifié de la même façon.

## L'adresse de la page

La page s'ouvre à `typer://app` sur iOS (comme dans l'app de bureau) et à `https://typer.hayasaku.fr`
sur Android, où une web view ne sert que du https : ce sont les fichiers embarqués qui répondent, pas
le site. Ce sont les deux adresses qu'accepte le service de Sélectionner / Supprimer le texte. Tout ce
que la page garde (réglages, styles, pages restées ouvertes) est attaché à cette adresse : ne plus la
changer une fois l'app publiée. Elle est fixée dans `TypeRViewController.swift` pour iOS et dans
`capacitor.config.json` pour Android.

## Ce qui est vérifié, ce qui ne l'est pas

Vérifié sur simulateur iOS (iOS 27.1, format téléphone) et sur émulateur tablette Android (Android 15),
avec de vrais PSD :

- ouvrir un fichier depuis le sélecteur du système, le modifier, Enregistrer par-dessus l'original ;
- Ouvrir des pages depuis un dossier entier, et enregistrer une page de ce dossier ;
- Exporter en PNG : la fenêtre « Enregistrer sous » du système s'ouvre dans le dossier de la page ;
- sur iOS, après avoir quitté et relancé l'app, la page revient et s'enregistre encore sur son fichier ;
- sur Android, le bouton Retour (ferme la fenêtre ouverte, puis le panneau, puis laisse l'app en
  arrière-plan), « Ouvrir avec TypeR Studio » quand l'app tourne déjà, et la réponse du service de
  Sélectionner / Supprimer le texte.

Vérifié aussi sur ce simulateur iOS, pour l'interface du téléphone : les barres du système (onglets
qui ouvrent et referment les panneaux, Annuler, Exporter, nom de la page), leur effacement derrière
une fenêtre, la fenêtre Polices avec Font FindeR, coller une ligne en touchant une bulle. L'assistant
de démarrage et les autres écrans l'ont été dans Chrome sans écran, à la taille d'un téléphone.

Pour le script Word : l'import d'un .docx choisi avec « Ouvrir un fichier » est vérifié sur le
simulateur iOS ; l'arrivée par la fenêtre de partage d'une autre app ne l'est pas (l'app Fichiers
ne se lance pas sur ce simulateur), ni rien de cela sur Android au-delà de la compilation.

Pas encore essayé : « Ouvrir avec TypeR Studio » sur iOS et au démarrage à froid sur Android,
Enregistrer par lot, un iPad, un vrai appareil, iCloud Drive et Google Drive.

Pour essayer « Ouvrir avec » sur l'émulateur Android (l'app reçoit le fichier comme d'une autre app) :

```sh
agent-device open fr.scanr.typerstudio --launch-args=-a --launch-args=android.intent.action.VIEW \
  --launch-args=-d --launch-args=content://media/external/file/<id> --launch-args=-t \
  --launch-args=image/vnd.adobe.photoshop --launch-args=--grant-read-uri-permission \
  --launch-args=--grant-write-uri-permission
```

## Ce qui reste à faire

- Les mises à jour du contenu, comme l'app de bureau (`web/desktop-update.json`, signé) : aujourd'hui
  l'app garde le `web/` avec lequel elle a été construite.
- La publication : compte Apple Developer et App Store Connect, compte Google Play, signatures,
  fiches des stores.
