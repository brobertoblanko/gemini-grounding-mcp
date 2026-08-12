# CLAUDE.md - Eigener Gemini-Search MCP-Server

## Projektziel

Dieses Projekt erstellt einen eigenen, minimalen MCP-Server (Model Context Protocol),
der Claude Code Zugriff auf Google-Websuche über die Gemini API mit Grounding gibt.
Claude Code soll damit ertüchtigt werden, aktuelle Informationen
z.B. über Python-Bibliotheken, Eigenarten von Betriebssystemen etc. recherchieren zu können,
um sich nicht rein auf Trainingsdaten verlassen zu müssen. Dies ist eine Ergänzung
zum bereits implementierten lokalen Memory-System.

Architektur, genutzte Gemini-API-Tools, Antwortformat und technische
Referenzen: siehe [specs.de.md](./docs/specs.de.md). Installation und
Registrierung: siehe [README.md](./README.md). Was ein einzelner Fehlercode der
Gemini-API bedeutet, ob er wiederholt wird und was er kostet:
[google_errors.de.md](./docs/google_errors.de.md).

**Zweisprachige Doku:** Für `docs/specs.md`, `docs/cli.md` und
`docs/google_errors.md` ist jeweils die englische Fassung kanonisch,
`docs/specs.de.md`, `docs/cli.de.md` und `docs/google_errors.de.md` sind die
deutschen Übersetzungen. Beide Fassungen eines Paares sind inhaltsgleich zu
halten - wird an einer etwas geändert, gehört dieselbe Änderung im selben
Commit in die andere. Eine Fassung allein zu aktualisieren ist schlimmer als
beide unverändert zu lassen, weil dann unbemerkt zwei Wahrheiten existieren.

## Nutzungsrahmen - WICHTIG

**Dieser MCP wird ausschließlich für Research- und Rechercheanfragen genutzt.**
Kein produktiver Einsatz, keine automatisierten Agentenketten ohne Kontrolle,
keine Anbindung an sensible Systeme (kein CRM, keine Firmendaten, keine Zahlungen).
Der Server dient nur dazu, Claude bei Bedarf eine aktuelle Websuche via Gemini
durchführen zu lassen.

## Regelkonformität gegenüber Google - WICHTIG

Dieser Server nutzt "Grounding with Google Search". Dafür gelten die
[Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms#grounding-with-google-search).
Sie schützen nicht die API, sondern die Verlage, deren Inhalte in den Antworten
zusammengefasst werden: Der Link zur Quelle ist das Einzige, was zu ihnen
zurückfließt, und Googles Redirect ist das, was diesen Rückfluss nachweisbar
macht.

Daraus folgen vier Invarianten. Sie sind heute erfüllt und sind ab sofort
verbindlich:

- **I1 - Kein Link wird je weggelassen.** Jeder `groundingChunk` mit einer URI
  erscheint in der Quellenliste, auch wenn kein Belegmarker auf ihn zeigt.
  Keine Obergrenze, keine Auswahl, keine Deduplizierung nach Domain.
- **I2 - Kein Link wird verändert, URI und Titel.** Redirect-URLs werden
  byteidentisch ausgegeben: nicht gekürzt, nicht auf die Domain reduziert,
  nicht ersetzt. Der Titel zählt ausdrücklich mit - laut Terms sind
  "titles or labels provided with those means to fetch web pages" Teil des
  Links.
- **I3 - Kein Redirect wird aufgelöst.** Der Server stellt keine Netzwerkanfrage
  an eine Redirect-URL. Einziger ausgehender Verkehr ist der SDK-Aufruf an die
  Gemini-API.
- **I4 - Nichts wird zwischengespeichert.** Grounded Results berühren nie die
  Festplatte. `config.json` enthält ausschließlich Modellnamen und
  Thinking-Level (Standard und Backup), sonst nichts.

Deduplizieren nach identischer URI ist erlaubt, weil dabei kein Ziel
verlorengeht. Deduplizieren nach Domain ist es nicht.

Die Quellenliste kostet mehr Tokens als der Antworttext. Das ist bekannt,
gemessen und akzeptiert - es ist der Preis des Tauschs, auf dem Grounding
beruht, und **kein Optimierungsauftrag**.

**Wer eine Änderung erwägt, die eine dieser Invarianten berührt, setzt sie nicht
um, sondern fragt zuerst nach.** Das gilt auch dann, wenn die Änderung als
Aufräumen, Kürzen oder Optimieren daherkommt.

Wörtlicher Text der Klauseln: Abschnitt "Grounding with Google Search" in den
[Gemini API Additional Terms of Service](https://ai.google.dev/gemini-api/terms#grounding-with-google-search).
Ausführliche Begründung, Messwerte und die beiden Klauseln, die regelmäßig
falsch zitiert werden: Abschnitt
[Terms-Konformität](./docs/specs.de.md#terms-konformität) in den Specs
([englisch](./docs/specs.md#terms-compliance)).
Festgenagelt sind I1 und I2 in `test/sources.test.js`; I3 und I4 sind
Abwesenheitsaussagen und stehen nur als Regel hier.

## Öffentliches Repo - was hier nicht hineingehört

Dieses Repository ist zur Veröffentlichung bestimmt. Jede getrackte Datei
(`CLAUDE.md`, `README.md`, `specs.md`, der Code, Commit-Messages) muss so
formuliert sein, dass ein fremder Leser sie ohne Kenntnis des
Entwicklungsrechners versteht.

**Alles Private oder auch nur potenziell Riskante gehört ausschließlich in
`CLAUDE.local.md`** - diese Datei steht in `.gitignore`, wird nie committet
und von Claude Code zusätzlich geladen. Das betrifft insbesondere absolute
Pfade des lokalen Rechners, Klarnamen und E-Mail-Adressen, alles rund um den
Gemini-API-Key sowie maschinenspezifisches Setup. In getrackten Dateien
stattdessen Platzhalter verwenden. Im Zweifel gehört ein Inhalt nach
`CLAUDE.local.md` - nachträgliches Bereinigen der Git-Historie ist aufwendig
und unzuverlässig.

## Kommentare im Code

**Sprache:** Englisch, ausnahmslos. Das gilt für Kommentare, Testtitel und
Assertion-Messages gleichermaßen - Testtitel erscheinen in der CI-Ausgabe und
sind damit so öffentlich wie der Code selbst. Ausgabetexte, Tool- und
Parameterbeschreibungen sind es ohnehin. Einzige Ausnahme sind Testdaten, die
ihren Zweck nur mit fremdsprachigem Inhalt erfüllen, etwa mehrbytige Zeichen
für die Byte-gegen-Zeichen-Prüfung in `test/citations.test.js`.

**Sieben Regeln für den Stil:**

1. Präsens, sachlich. Keine rhetorischen Fragen, keine Erzählung, keine
   Wertung des Codes.
2. Ein Satz sagt, warum es so ist. Ein zweiter kommt nur dazu, wenn es eine
   Falle gibt.
3. Kontrafaktisches als Halbsatz, nicht als Absatz:
   `Without X the SDK repeats nothing.`
4. Eine Meta-Regel wird **einmal** erklärt, an der Stelle, an der sie zuerst
   auftritt. Weitere Vorkommen entfallen ersatzlos.
5. Kein Kommentar beschreibt, was ein Test prüft. Einzige Ausnahme: bei einer
   Invariante ein angehängtes `Pinned by test/<datei>.test.js`.
6. Jede Zahl, jeder Eigenname und jeder Fremdverweis bleibt wörtlich erhalten:
   Statuscodes, Messwerte, SDK-Funktionsnamen, Issue-Links.
7. Ein Kommentar bleibt ohne den verlinkten Spec-Abschnitt vollständig
   handlungsleitend. Der Verweis liefert Tiefe, nicht Verständlichkeit.

**Verweise auf die Spec** statt wiederholter Herleitung, in der Form
`Full derivation: docs/specs.md, "<exakte Überschrift>".` Verwiesen wird auf
die englische Fassung, weil sie kanonisch ist, und **niemals über
Zeilennummern** - die verrutschen lautlos und sind unprüfbar, während eine
umbenannte Überschrift per `grep` auffindbar bleibt. Verweise auf Symbole im
eigenen Code (`see SERVER_DEADLINE_SECONDS`) sind die haltbarste Form.

**Keine Aussage darf nirgends landen.** Wer eine Begründung aus einem Kommentar
entfernt, prüft vorher, ob sie in `docs/specs.md` steht. Tut sie das nicht,
bleibt sie im Kommentar oder wird in `docs/specs.md` **und** `docs/specs.de.md`
im selben Commit ergänzt. Besonders zu schützen sind gemessene Zahlen,
verworfene Alternativen samt Grund, unsichtbare SDK-Interna und
Verhaltensfallen wie `console.error` statt `console.log` (über stdout läuft
JSON-RPC).

Kommentare an den Invarianten I1 bis I4 werden redigiert, aber nicht
verdichtet: Invariantennummer, Warnung und der Verweis auf diese Datei plus
`docs/specs.md, "Terms compliance"` bleiben in jedem Fall stehen.

## Verhaltensregeln für Claude Code in diesem Projekt

**Modellwahl und Thinking-Level:**

- Welches Modell und Thinking-Level ein `gemini-search`-Aufruf tatsächlich genutzt hat, muss für mich als User **immer sichtbar** sein - dafür steht es im Antwort-Footer (siehe specs.md). Ich soll nie raten müssen, was verwendet wurde
- Standardmäßig den gespeicherten Standard (Modell + Thinking-Level aus `config.json`) nutzen und bei `gemini-search` nichts explizit setzen, außer ich fordere für diesen einen Aufruf ausdrücklich etwas Abweichendes
- **Kein selbstgewähltes Fallback auf ein anderes Modell.** Scheitert ein
  Aufruf, wird der Fehler gemeldet - nicht auf gut Glück ein anderes Modell
  probiert. Das einzige zulässige Ausweichen ist das Backup-Modell, das ich
  vorab in der `config.json` eingetragen habe; es läuft im Server ab und steht
  danach im Footer. Ein bei `gemini-search` ausdrücklich genanntes `model`
  schaltet es für diesen Aufruf ab
- Vor einer Modelländerung immer zuerst `gemini-list-models` aufrufen, um zu
  prüfen, ob das gewünschte Modell tatsächlich verfügbar ist
- `gemini-set-model` nur nach expliziter Anweisung durch mich nutzen, nie
  eigenständig das Standardmodell oder das Backup-Modell wechseln
- Nach einer Änderung kurz bestätigen, welches Modell ab jetzt als Standard aktiv ist

**API-Key-Sicherheit:**

Die `config.json` - sie liegt am plattformüblichen Ort für Nutzer-State, nicht
im Projektordner (siehe specs.md) - speichert ausschließlich Modellname und
Thinking-Level, niemals den API-Key oder andere sensible Daten. Der API-Key
bleibt ausschließlich über die Umgebungsvariable `GEMINI_API_KEY` verwaltet.

**Quellenliste und Footer:**

Quellenliste und Footer werden bei jedem Aufruf von `gemini-search`
automatisch angehängt und dürfen nicht entfernt oder umformuliert werden -
sie dienen der Transparenz über die genutzten Quellen und den tatsächlichen
Ressourcenverbrauch jedes einzelnen Tool-Calls.

**Fehlerbehandlung:**

Bei Fehlern in der API-Antwort den Fehler klar melden, keine Fallback-Modelle
automatisch ausprobieren.
