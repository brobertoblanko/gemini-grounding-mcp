# cli.de.md - Kommandozeilenwerkzeug

*This page in [English](./cli.md).*

Das Paket liefert neben dem MCP-Server ein Kommandozeilenwerkzeug mit.
Beide laufen auf demselben Kern und teilen sich dieselbe Konfigurationsdatei - was hier geprüft oder geändert wird, gilt also auch für den Server.

Die [README](https://github.com/brobertoblanko/gemini-grounding-mcp#command-line-tool) beschreibt die alltäglichen Befehle.
Diese Seite sammelt die Teile, die erst wichtig werden, wenn etwas schiefgeht oder wenn aus einem Klon heraus gearbeitet wird.

## Wozu überhaupt

Drei Situationen, in denen die CLI der kürzere Weg ist:

- **Vor der Registrierung des Servers.** Zu prüfen, ob der API-Key funktioniert und die Modellwahl gültig ist, kostet einen Befehl und keinen Client-Neustart.
- **Während der Entwicklung.** Eine Änderung lässt sich sofort ausprobieren, ohne den MCP-Client neu zu starten, der sonst den alten Stand festhält.
- **Wenn etwas fehlschlägt.** Die CLI gibt den vollständigen Fehler samt Originalmeldung von Google aus, die der MCP-Server für den Client auf eine Zeile verdichten muss.

## Wie der Aufruf erfolgt

Die Beispiele auf dieser Seite verwenden die Kurzform `gemini-grounding`.
Es gibt sie, sobald das Paket global installiert wurde:

```bash
npm install -g @brobertoblanko/gemini-grounding-mcp
```

Wer den MCP-Server über `npx` registriert hat, hat nichts installiert - dann liegt der Befehl nicht im `PATH`.
Jeder Befehl funktioniert stattdessen so:

```bash
npx -p @brobertoblanko/gemini-grounding-mcp gemini-grounding config
```

Auf das `-p` kommt es an: Es benennt das Paket, das Argument dahinter den Befehl innerhalb dieses Pakets.
Ein bloßes `npx @brobertoblanko/gemini-grounding-mcp` startet dagegen den Eintrag, dessen Name dem Paketnamen entspricht - und das ist der MCP-Server, der danach stumm auf stdio wartet und wie ein hängender Prozess aussieht.

Aus einem Klon heraus wird stattdessen `node cli.js` verwendet, siehe [Aus einem Klon heraus arbeiten](#aus-einem-klon-heraus-arbeiten).

## Behandlung der Argumente

Alles, was kein bekannter Unterbefehl ist, gilt als Suchanfrage - und zwar als **genau ein Argument**.
Eine Frage mit Leerzeichen muss daher in Anführungszeichen stehen.

```bash
gemini-grounding "welche node-version ist aktuell lts"
```

Ohne Anführungszeichen bricht der Aufruf mit einer Meldung ab, statt eine Anfrage zu senden, aus der die Optionsauswertung einzelne Wörter herausgeschnitten hat.
Ohne diese Prüfung wäre aus `… what does --thinking high mean …` die Anfrage `what does mean …` geworden: eine Anfrage, die plausibel aussieht, eine plausible Antwort liefert und stillschweigend nicht die gestellte Frage ist.

Unbekannte Optionen (`--al` statt `--all`) und überzählige Argumente sind ebenfalls Fehler mit Exit-Code 1.
Nichts davon wird stillschweigend übergangen.

## Wo eine Option gilt

Dieselbe Option bedeutet je nach Befehl etwas anderes, deshalb nimmt jeder Befehl nur die an, die bei ihm etwas bewirken.
Eine Option ohne Bedeutung für den gewählten Befehl bricht mit Exit-Code 1 ab - sie wird nie entgegengenommen und dann klammheimlich verworfen.

| Aufruf | Wirkung |
| --- | --- |
| `"<anfrage>" --model <id> --thinking <level>` | Gilt nur für diesen Aufruf, nichts wird gespeichert |
| `set-model <id> --thinking <level>` | Speichert **beides** |
| `set-thinking <level> --model <id>` | Speichert **beides** |
| `set-backup <id> --thinking <level>` | Speichert das Backup-Modell **und** sein eigenes Thinking-Level |
| `set-backup <id>` | Speichert das Backup-Modell und **entfernt** ein zuvor gespeichertes Backup-Level |
| `set-backup --thinking <level>` | Ändert nur das Level des bereits gespeicherten Backups |
| `set-backup off --thinking <level>` | Fehler - ein abgeschaltetes Backup hat kein Thinking-Level |
| `set-model <id> --model <id2>` | Fehler - zwei Modelle, und welches gemeint ist, wissen nur Sie |
| `models --all` | Listet alle Modelle, auch die unbrauchbaren |
| `config`, `help`, `models` mit `--model` / `--thinking` | Fehler |

Jedes Speichern antwortet zweimal - was sich geändert hat, und was ab jetzt gilt:

```console
$ gemini-grounding set-model gemini-flash-latest --thinking low
Saved - Model: gemini-flash-latest, Thinking level: low

Primary: gemini-flash-latest · low
Backup:  gemini-3.5-flash · low (inherited)
```

Die erste Zeile nennt jeden Wert, der tatsächlich geschrieben wurde; was dort nicht steht, ist auch nicht in der Datei gelandet.
Die beiden darunter nennen den vollständigen gespeicherten Zustand, sodass auf eine Änderung nie ein `config` folgen muss, um zu sehen, womit die nächste Anfrage tatsächlich läuft.

Beim Backup steht dabei der Wert und nicht bloß das Wort „inherited": Womit das Backup liefe, wenn es jetzt einspränge, ist die Auskunft, um die es geht.
Der Zusatz sagt dazu, dass der Wert nicht ihm gehört, sondern mitwandert - bekommt ein Aufruf sein eigenes `--thinking`, erbt das Backup dieses.

## Das Backup-Modell

`set-backup <id>` benennt ein Modell, an das dieselbe Anfrage geht, wenn das Standardmodell scheitert - etwa weil es überlastet ist (`503`).
Ohne Einstellung aus; `set-backup off` schaltet es wieder ab.
Welche Fehler es auslösen: [google_errors.de.md](./google_errors.de.md).

Anders als das Standardmodell und sein Level wird das Backup **als Einheit** geschrieben.
Ein Backup-Modell ohne `--thinking` zu nennen entfernt ein zuvor gespeichertes Backup-Level, und das Backup erbt das Level des Aufrufs, für den es einspringt.
Das Level gehört zu diesem einen Modell - bliebe es beim Wechsel des Backups liegen, gälte es stillschweigend für ein Modell, für das es nie gewählt wurde.
Die Regel steht in `setSavedConfig` und nicht in der CLI, damit `gemini-set-model` auf dem MCP-Server ihr ebenfalls folgt.

Um nur das Level zu ändern, lassen Sie das Modell weg:

```console
$ gemini-grounding set-backup --thinking minimal
Saved - Backup thinking level: minimal

Primary: gemini-flash-latest · low
Backup:  gemini-3.5-flash · minimal
```

Dafür muss bereits ein Backup gespeichert und eingeschaltet sein - ein Level ohne sein Modell hat keinen Bezug:

```console
$ gemini-grounding set-backup --thinking minimal
no backup model is set - a thinking level on its own has nothing to belong to. Name the backup model together with the level.
```

Dasselbe gilt für `set-backup off --thinking <level>`, das mit `a backup that is switched off has no thinking level` abbricht.
Beide Meldungen kommen aus `findBackupLevelProblem` in `config.js` und lauten auf dem MCP-Server genauso - deshalb nennen sie keinen Befehl der CLI.

Standard und Backup dürfen nicht dasselbe Modell sein, und jeder Befehl, der ein Modell schreibt, weist das ab - `set-model <id>`, `set-thinking <level> --model <id>` und `set-backup <id>` gleichermaßen:

```console
$ gemini-grounding set-backup gemini-flash-latest
"gemini-flash-latest" is already the default model - a backup only helps if it is a different one.
```

Geprüft wird der Zustand, den das Schreiben **erzeugen würde**, und deshalb sitzt die Prüfung an der einen Stelle, durch die alle drei Befehle laufen (`findModelCollision` in `config.js`, gemeinsam mit dem MCP-Server genutzt).
Ein Befehl, der gar kein Modell nennt, wird auch dann durchgelassen, wenn die gespeicherten Werte bereits kollidieren: `set-thinking low` hat diesen Zustand nicht verursacht und soll nicht an ihm scheitern.
`runSearch` fängt die Kollision ein zweites Mal ab, aber erst beim nächsten fehlgeschlagenen Aufruf - bis dahin war das Backup lautlos tot, und genau dafür gibt es diese Prüfung.

**`--model` bei einer Suche schaltet das Backup für diesen Aufruf ab.**
Ein Modell zu nennen heißt meist, genau dieses Modell prüfen zu wollen, und eine Antwort von einem anderen beantwortet diese Frage nicht.

`gemini-grounding config` zeigt alle drei Zustände - ein Modell, `disabled` oder `not set`.
Die letzten beiden verhalten sich gleich; der Unterschied hält fest, ob die Entscheidung je getroffen wurde.

## Fehler bleiben vollständig sichtbar

Anders als der MCP-Server gibt die CLI den vollständigen Stacktrace samt Original-Fehlermeldung der Google-API aus und endet mit Exit-Code 1.

Beim Testen ist genau das erwünscht.
Eine Meldung wie `ApiError: {"error":{"code":503, ...}}` sagt, dass die Anfrage nicht bei Google angekommen ist - ein anderes Problem als eine kaputte Installation, und eines, gegen das nichts hilft außer einem späteren Versuch.

Ein reiner Bedienfehler (falsches Argument, unbekannte Option, leere Anfrage) gibt nur die eine erklärende Zeile aus, ebenfalls mit Exit-Code 1.
Für einen Tippfehler braucht niemand einen Stacktrace.

## Den API-Key prüfen

```console
$ gemini-grounding config
Primary: gemini-flash-latest · medium
Backup:  gemini-3.5-flash · medium (inherited)
API key: set (39 chars)
Config:  /home/sie/.config/gemini-grounding-mcp/config.json
```

Die ersten beiden Zeilen sind dieselben, die jedes Speichern ausgibt - es gibt damit nur eine Darstellung von „womit arbeite ich gerade", die man kennen muss.
`config` ergänzt die beiden Angaben, die nur hier interessieren.

Beim Key wird nur geprüft, ob überhaupt einer in der Umgebung ankommt; ausgegeben wird seine Länge - **niemals der Wert selbst**, auch nicht gekürzt.
Ob der Key tatsächlich gültig ist, kann nur eine echte Anfrage zeigen; ein erfolgreiches `config` ist also eine notwendige, keine hinreichende Bedingung.

## Aus einem Klon heraus arbeiten

Statt `gemini-grounding` wird `node cli.js` verwendet:

```bash
node cli.js "deine Anfrage"
node cli.js config
```

Um den Befehl stattdessen systemweit verfügbar zu machen, genügt einmalig `npm link` im Klon.
Das legt eine Verknüpfung auf `cli.js` im globalen npm-Verzeichnis an: unter Windows ein `.cmd`/`.ps1`-Paar, sonst einen Symlink.
Weil es eine Verknüpfung und keine Kopie ist, wirken Änderungen an `cli.js` sofort - genau darum geht es während der Entwicklung.

Rückgängig machen:

```bash
npm unlink -g @brobertoblanko/gemini-grounding-mcp
```

Zu beachten ist der **Paketname**, nicht der Befehlsname `gemini-grounding`.
Mit dem Befehlsnamen meldet npm lediglich `up to date` und entfernt nichts - ein Fehlverhalten, das wie Erfolg aussieht.

## Umstieg von einem Klon älter als 1.1.0

Vor 1.1.0 lag die Konfigurationsdatei neben `index.js` im Repository.
Diese Datei wird nicht mehr gelesen, und es wird nichts automatisch übernommen.

`gemini-grounding config` zeigt, wo die Datei jetzt hingehört; danach entweder die alte dorthin verschieben oder beide Werte einfach neu setzen:

```bash
gemini-grounding set-model <modell-id>
gemini-grounding set-thinking medium
```

Die übrig gebliebene Kopie im Klon kann gelöscht werden.

## Exit-Codes

| Code | Bedeutung |
| --- | --- |
| 0 | Der Befehl war erfolgreich |
| 1 | Bedienfehler, oder der API-Aufruf ist fehlgeschlagen |

Für API-Fehler gibt es keinen eigenen Code.
Der Unterschied steht in der Ausgabe: Ein Bedienfehler ist eine Zeile, ein API-Fehler ein Stacktrace mit Googles Originalmeldung.
