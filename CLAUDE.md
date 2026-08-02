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
Registrierung: siehe [README.md](./README.md).

**Zweisprachige Doku:** Für `docs/specs.md` und `docs/cli.md` ist jeweils die
englische Fassung kanonisch, `docs/specs.de.md` und `docs/cli.de.md` sind die
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
  Festplatte. `config.json` enthält ausschließlich Modellname und
  Thinking-Level.

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

## Verhaltensregeln für Claude Code in diesem Projekt

**Modellwahl und Thinking-Level:**

- Welches Modell und Thinking-Level ein `gemini-search`-Aufruf tatsächlich genutzt hat, muss für mich als User **immer sichtbar** sein - dafür steht es im Antwort-Footer (siehe specs.md). Ich soll nie raten müssen, was verwendet wurde
- Standardmäßig den gespeicherten Standard (Modell + Thinking-Level aus `config.json`) nutzen und bei `gemini-search` nichts explizit setzen, außer ich fordere für diesen einen Aufruf ausdrücklich etwas Abweichendes
- Kein automatisches Fallback auf ein anderes Modell ohne Rückfrage
- Vor einer Modelländerung immer zuerst `gemini-list-models` aufrufen, um zu
  prüfen, ob das gewünschte Modell tatsächlich verfügbar ist
- `gemini-set-model` nur nach expliziter Anweisung durch mich nutzen, nie
  eigenständig das Standardmodell wechseln
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
