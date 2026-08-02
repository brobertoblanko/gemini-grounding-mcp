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
| `set-model <id> --model <id2>` | Fehler - zwei Modelle, und welches gemeint ist, wissen nur Sie |
| `models --all` | Listet alle Modelle, auch die unbrauchbaren |
| `config`, `help`, `models` mit `--model` / `--thinking` | Fehler |

Die Bestätigungszeile nennt jeden Wert, der tatsächlich geschrieben wurde:

```console
$ gemini-grounding set-model gemini-flash-latest --thinking low
Saved - Model: gemini-flash-latest, Thinking level: low
```

Was dort nicht steht, ist auch nicht in der Datei gelandet.

## Fehler bleiben vollständig sichtbar

Anders als der MCP-Server gibt die CLI den vollständigen Stacktrace samt Original-Fehlermeldung der Google-API aus und endet mit Exit-Code 1.

Beim Testen ist genau das erwünscht.
Eine Meldung wie `ApiError: {"error":{"code":503, ...}}` sagt, dass die Anfrage nicht bei Google angekommen ist - ein anderes Problem als eine kaputte Installation, und eines, gegen das nichts hilft außer einem späteren Versuch.

Ein reiner Bedienfehler (falsches Argument, unbekannte Option, leere Anfrage) gibt nur die eine erklärende Zeile aus, ebenfalls mit Exit-Code 1.
Für einen Tippfehler braucht niemand einen Stacktrace.

## Den API-Key prüfen

```bash
gemini-grounding config
```

Geprüft wird nur, ob überhaupt ein Key in der Umgebung ankommt; ausgegeben wird seine Länge - **niemals der Wert selbst**, auch nicht gekürzt.
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
