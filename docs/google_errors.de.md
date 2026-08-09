# google_errors.md - Fehlercodes der Gemini-API

*This page in [English](./google_errors.md).*

Nachschlagewerk für die Fehler, die bei diesem Server ankommen können: was der Code bedeutet, ob er sich von allein wieder behebt, ob er Geld kostet und wie dieser Server auf ihn reagiert.

Herkunft der Angaben ist pro Eintrag vermerkt.
"Gemessen" heißt: in diesem Projekt tatsächlich beobachtet und in Code oder Tests festgehalten.
"Dokumentiert" heißt: aus Googles Troubleshooting-Seite übernommen, hier aber nie aufgetreten.

## Wie ein Fehler ankommt

Die API antwortet mit einem JSON-Körper, der immer dieselbe Form hat:

```json
{"error":{"code":503,"message":"This model is currently experiencing high demand.","status":"UNAVAILABLE"}}
```

Das SDK macht daraus einen `ApiError`.
Dessen `message` ist dieser JSON-Text **unverändert und vollständig**, `error.status` ist die Zahl (`503`).
`describeError()` in `gemini.js` reicht ihn deshalb unangetastet durch: Code, Statusname und Klartext stehen bereits darin.

Der Statusname (`UNAVAILABLE`, `RESOURCE_EXHAUSTED`, ...) stammt aus `google.rpc.Code` und ist über alle Google-APIs derselbe.
Er ist zuverlässiger als der HTTP-Code, weil sich mehrere Statusnamen denselben HTTP-Code teilen können.

Manche Fehler tragen zusätzlich ein `details`-Array mit einem maschinenlesbaren `reason`.
Das ist die feinste verfügbare Unterscheidung und an einer Stelle entscheidend, siehe `400 INVALID_ARGUMENT` weiter unten.

Ein Fehler **ohne** HTTP-Code ist kein API-Fehler, sondern ein Netzwerkfehler: siehe den letzten Abschnitt.

## Übersicht

| Code | Status | Kurz | Retry? | Backup? | Kostet? |
| --- | --- | --- | --- | --- | --- |
| 400 | `INVALID_ARGUMENT` | Anfrage kaputt oder Schlüssel ungültig | nein | **ja**, außer bei `API_KEY_INVALID` | nein |
| 400 | `FAILED_PRECONDITION` | Abrechnung/Region | nein | ja | nein |
| 401 | `UNAUTHENTICATED` | kein gültiger Schlüssel | nein | nein | nein |
| 403 | `PERMISSION_DENIED` | Schlüssel darf das nicht | nein | nein | nein |
| 404 | `NOT_FOUND` | Modell gibt es nicht (mehr) | nein | **ja** | nein |
| 408 | `REQUEST_TIMEOUT` | Zwischenstation gab auf | **ja** | ja | unklar |
| 429 | `RESOURCE_EXHAUSTED` | Kontingent erschöpft | nein | **ja** | nein |
| 500 | `INTERNAL` | Fehler bei Google | **ja** | ja | teilweise |
| 502 | `BAD_GATEWAY` | Fehler vor Google | **ja** | ja | teilweise |
| 503 | `UNAVAILABLE` | Modell überlastet | **ja** | **ja** | nein |
| 504 | `DEADLINE_EXCEEDED` | unsere eigene Frist | nein | nein | **ja** |
| - | `fetch failed` | Verbindung tot | nein | nein | teilweise |

"Retry?" meint die vier Versuche aus `RETRY_OPTIONS` in `gemini.js`, die das SDK selbst abarbeitet.

"Backup?" meint den Wechsel auf ein zweites Modell, falls eines eingerichtet ist.
Er greift erst, wenn alle Wiederholungen verbraucht sind, und ist eine **Negativliste**: Alles außer den hier mit "nein" markierten Fällen weicht aus.
Die beiden Spalten sind absichtlich nicht deckungsgleich, weil sie verschiedene Fragen beantworten - der Retry "hilft Warten?", das Backup "kann ein anderes Modell der Unterschied sein?".
Bei `429` gehen die Antworten auseinander.

"Kostet?" bezieht sich auf Tokens: Abgelehnt wird kostenlos, was Google zurückweist, **bevor** die Generierung anläuft.
Läuft sie an, werden Input-Tokens voll und Output-Tokens bis zum tatsächlichen Ende berechnet, auch wenn die Antwort niemanden mehr erreicht.

## Die Codes im Einzelnen

### 400 `INVALID_ARGUMENT` - die Anfrage selbst ist fehlerhaft

Dokumentiert und in `test/retry.test.js` als nicht wiederholbar festgehalten.

Ein Feld fehlt, ein Wert ist unzulässig, das Format stimmt nicht.
Der häufigste Fall bei diesem Server ist ein Modell ohne Thinking-Unterstützung: `Thinking level is not supported for this model.`
`runSearch()` schickt immer ein Thinking-Level mit, deshalb filtert `gemini-list-models` genau darauf.

Beim zweiten Mal geht dieselbe Anfrage genauso schief.
Googles eigene Empfehlung: "Do not retry on client errors (like 400 or 403)."

**Ein Backup-Modell greift hier trotzdem**, und zwar aus gutem Grund: Dass die Anfrage bei einem anderen Modell durchläuft, beweist, dass nicht sie das Problem war, sondern das Modell - genau der Thinking-Fall von oben.

**Die eine Ausnahme: ein ungültiger API-Schlüssel.**
Gemessen kommt der **nicht** als 401 oder 403, sondern als 400 mit `API key not valid. Please pass a valid API key.` und dem Grund `API_KEY_INVALID` in `details`.
Der Schlüssel gilt für beide Modelle, ein Ausweichen wäre also aussichtslos.
Weil der Statuscode diesen Fall nicht von einem gewöhnlichen 400 unterscheidet, prüft der Server hier ausnahmsweise den `reason`.

### 400 `FAILED_PRECONDITION` - Abrechnung oder Region

Dokumentiert, hier nie aufgetreten.

Derselbe HTTP-Code, anderer Grund: Das kostenlose Kontingent steht im Land des Aufrufers nicht zur Verfügung, das Projekt braucht ein aktives Abrechnungskonto.
Nur am Statusnamen von `INVALID_ARGUMENT` zu unterscheiden, nicht am Code.

**Das „ja" in der Backup-Spalte ist Absicht, obwohl ein Fallback hier aussichtslos ist**: Die Ursache hängt am Cloud-Projekt, und das nutzt auch das zweite Modell - dasselbe Argument, das 401 und 403 draußen hält.
Drei Gründe, ihn trotzdem drinzulassen.
Der Fall wurde hier nie gemessen, und die Negativliste nimmt nur aus, was gemessen wurde.
Der zweite Versuch wird vor der Generierung abgelehnt und kostet deshalb nichts - verloren geht ein Augenblick Wartezeit, keine Tokens.
Und es bräuchte eine zweite Prüfung unterhalb des Statuscodes: `API_KEY_INVALID` ist die einzige, sie existiert aus Notwendigkeit, weil sie sich hinter einem gewöhnlichen 400 versteckt, und eine zweite machte aus dieser Notwendigkeit stillschweigend eine Gewohnheit.

### 401 `UNAUTHENTICATED` - kein gültiger Schlüssel

Kein Schlüssel mitgeschickt oder einer, den die API nicht kennt.
Fällt vor der Ausführung an und ist damit kostenlos.

Kommt bei diesem Server selten so an, gleich aus zwei Gründen: Fehlt `GEMINI_API_KEY` ganz, bricht `getClient()` schon vorher mit einer eigenen Meldung ab, ohne die API zu berühren - und ein vorhandener, aber unbrauchbarer Schlüssel kommt als 400 zurück, siehe oben.

Kein Backup, weil derselbe Schlüssel auch für das zweite Modell gilt.

### 403 `PERMISSION_DENIED` - der Schlüssel darf das nicht

Dokumentiert und in `test/retry.test.js` als nicht wiederholbar festgehalten.

Der Schlüssel existiert, hat aber keine Berechtigung für dieses Modell oder diese Ressource.
Typisch bei einem Schlüssel aus einem anderen Cloud-Projekt als dem gemeinten.

Kein Backup, aus demselben Grund wie beim 401.

### 404 `NOT_FOUND` - das Modell gibt es nicht (mehr)

Dokumentiert und in `test/retry.test.js` als nicht wiederholbar festgehalten.

Wichtig im Zusammenspiel mit `gemini-list-models`: **Gelistet zu sein ist keine Zusage, dass ein Modell noch antwortet.**
Abgekündigte Modelle bleiben in der Liste stehen und liefern beim Aufruf 404.
Ein Feld, an dem sich das vorher erkennen ließe, gibt es nicht.

Ein Backup greift hier, obwohl der Zustand dauerhaft ist: Die Anfrage kommt durch, und die Footer-Zeile fordert bei **jedem** Aufruf dazu auf, den Standard zu korrigieren.
Das ist beharrlicher als ein Fehler, der einmal aufblitzt und in Vergessenheit gerät.

### 408 `REQUEST_TIMEOUT` - eine Zwischenstation hat aufgegeben

Steht in `RETRY_OPTIONS`, hier aber nie beobachtet, und das hat einen Grund.

Von Google selbst kommt bei Zeitüberschreitung ein 504, nicht ein 408.
Läuft die Anfrage ganz ins Leere, bricht Node sie ohne jeden HTTP-Status ab.
Ein echter 408 könnte also nur von einem Proxy oder Load Balancer dazwischen stammen.
Er steht der Vollständigkeit halber in der Retry-Liste: Wenn er auftritt, gibt es keine Serverangabe, an der man sich ausrichten könnte, und blinder Backoff ist das einzig Mögliche.

### 429 `RESOURCE_EXHAUSTED` - Kontingent erschöpft

Dokumentiert; das Verhalten des SDK dazu ist in diesem Projekt nachgeprüft und in `test/retry.test.js` festgehalten.

Zu viele Anfragen pro Minute, zu viele Tokens pro Minute oder das Tageskontingent.
Die Grenzen gelten **pro Modell und Projekt**, nicht pro Schlüssel: Ein anderes Modell hat einen eigenen Zähler.

Wird von diesem Server **absichtlich nicht wiederholt**.
Die API nennt die Wartezeit selbst mit, als `RetryInfo` in `error.details` (gemessen: `"retryDelay": "53s"`).
Das SDK wertet sie nicht aus, die Zeichenkette `RetryInfo` kommt im gesamten Bundle nicht vor, und rechnet stattdessen blind exponentiell.
Bei geforderten 53 Sekunden wären alle vier Versuche nach rund 15 Sekunden verbraucht, also lange bevor die Sperre überhaupt abläuft.
Der 429 kommt deshalb sofort und unverändert beim Client an, statt die Antwort um wirkungslose Wartezeit zu verlängern.

**Beim Backup ist es genau umgekehrt**, und das ist der Fall, an dem sich die beiden Listen am deutlichsten unterscheiden: Warten bringt nichts, ausweichen dagegen sofort etwas, weil der eigene Zähler des zweiten Modells noch Luft hat.

Fällt vor der Ausführung an und ist damit kostenlos.

### 500 `INTERNAL` - Fehler bei Google

Dokumentiert, hier nie aufgetreten.
Wird wiederholt, und danach greift ein Backup.

Kann auch einen zu langen Eingabekontext bedeuten.
Anders als beim 503 kann die Generierung bereits gelaufen sein, dann wird sie abgerechnet.

### 502 `BAD_GATEWAY` - Fehler vor Google

Nicht dokumentiert, hier nie aufgetreten, steht in Googles Standard-Retry-Liste.
Wird wiederholt, und danach greift ein Backup.

Eine Zwischenstation hat eine ungültige Antwort weitergereicht.
Wie beim 500 ist unklar, ob dahinter schon Rechenzeit steckt.

### 503 `UNAVAILABLE` - das Modell ist überlastet

**Der einzige Fehler, der bei diesem Server je beobachtet wurde**: dreimal in Folge innerhalb einer Minute, jeweils mit `This model is currently experiencing high demand.` und dem Hinweis, das sei üblicherweise vorübergehend.

Wird wiederholt und ist der Grund, warum `RETRY_OPTIONS` überhaupt existiert.
Ohne diese Konfiguration wiederholt das SDK **nichts**, auch wenn Googles Dokumentation pauschal das Gegenteil behauptet.

Zwei Eigenschaften machen ihn zum harmlosesten aller Fehler und zugleich zum lohnendsten Ziel für Gegenmaßnahmen:

- Er kommt **sofort** zurück, weil Google die Anfrage abweist, statt sie zu bearbeiten. Vier Versuche kosten deshalb nur die Backoff-Pausen, nicht vier Generierungen.
- Er ist **kostenlos**, weil nichts gerechnet wurde.

Die Überlastung ist beobachtbar **modellabhängig**, offenbar sogar zwischen einem Alias und dem Modell, auf das er zeigt.
Genau daraus entsteht das Backup-Modell: Dieselbe Anfrage geht nach den erschöpften Wiederholungen an ein zweites, vorab bestimmtes Modell.

### 504 `DEADLINE_EXCEEDED` - die eigene Frist ist abgelaufen

Dokumentiert und in `test/retry.test.js` als nicht wiederholbar festgehalten.

Bei diesem Server ist ein 504 im Regelfall **nicht** Googles überlastetes Gateway, sondern die Frist, die er selbst mitschickt: `X-Server-Timeout: 290` (siehe `SERVER_DEADLINE_SECONDS` in `gemini.js`).
Nach 290 Sekunden bricht Googles Gateway die Generierung ab, statt weiterzurechnen.

Wird **absichtlich nicht wiederholt**, und es greift auch **kein Backup**.
Beides wäre eine weitere volle Generierung bis zum Fristende, und abgerechnet wird sie trotzdem.
Die beiden möglichen Ursachen sind dabei nicht zu trennen: Die Entscheidung fällt am Statuscode, lange bevor irgendwer den Körper der Antwort zu sehen bekäme.
Von beiden ist die teure die wahrscheinlichere, also gibt die Liste den Code auf.

Der einzige Fehler, der **sicher** abgerechnet wird.

### Ohne Code: `fetch failed`

In `test/errors.test.js` an einem echten Node-Fehler festgehalten.

Kein API-Fehler, sondern ein Netzwerkfehler.
Nodes `fetch` nennt **jeden** davon `fetch failed`: abgelehnte Verbindung, unbekannter Host, Zeitüberschreitung, alles dasselbe Wort.
Was tatsächlich geschah, steht ausschließlich in `error.cause`, und genau die ginge verloren, weil ein MCP-Tool nur eine Zeile Text zurückgeben kann.
`describeError()` hängt sie deshalb an:

```text
fetch failed (UND_ERR_HEADERS_TIMEOUT: Headers Timeout Error)
```

Der wichtigste Fall dahinter ist `UND_ERR_HEADERS_TIMEOUT`: Node bricht eine schweigende Verbindung nach **306,8 Sekunden** ab (Undicis `headersTimeout` von 300 Sekunden plus Verbindungsaufbau).
Das ist das kürzeste Glied der Kette, kürzer als die 1800 Sekunden, die der MCP-Client von Claude Code wartet, und Google kennt ohne den Frist-Header überhaupt keine Grenze.
Genau deshalb liegen die 290 Sekunden knapp darunter: damit Google aufhört, bevor die Leitung gekappt wird, und ein 504 mit Begründung ankommt statt ein bloßer Verbindungsabbruch.

Was jenseits dieser Grenze noch generiert wird, kann niemand mehr entgegennehmen, bezahlt wird es trotzdem.
Eine Verbindung, die Google nie erreicht hat - abgelehnt, unbekannter Host, falscher Port -, kostet dagegen nichts; deshalb steht in der Tabelle "teilweise" und der 504 bleibt der einzige Fehler, der sicher abgerechnet wird.
Ein Backup greift deshalb nicht, wie beim 504 auch.

Ein `code` ist nicht garantiert: Gemessen liefert `ECONNREFUSED` einen, ein unzulässiger Port dagegen nicht.

## Wo das im Code steht

| Was | Wo |
| --- | --- |
| Retry-Liste samt Begründung der Auslassungen | `RETRY_OPTIONS` in `gemini.js` |
| Ausnahmen vom Backup-Modell | `NO_FALLBACK_STATUS` in `gemini.js` |
| Die eigene Frist und ihre Herleitung | `SERVER_DEADLINE_SECONDS` in `gemini.js` |
| Aufbereitung für den Client | `describeError()` in `gemini.js` |
| Geprüftes Retry-Verhalten pro Code | `test/retry.test.js` |
| Geprüftes Backup-Verhalten pro Code | `test/fallback.test.js` |
| Geprüfte Fehlermeldungen | `test/errors.test.js` |

Wie das Backup-Modell eingerichtet wird und was der Footer dazu sagt: Abschnitt [Das optionale Backup-Modell](./specs.de.md#das-optionale-backup-modell) in den Specs.
