# CLAUDE.md — Eigener Gemini-Search MCP-Server

## Projektziel

Dieses Projekt erstellt einen eigenen, minimalen MCP-Server (Model Context Protocol),
der Claude Code Zugriff auf Google-Websuche über die Gemini API mit Grounding gibt.
Claude Code soll damit ertüchtigt werden, aktuelle Informationen
z.B. über Python-Bibliotheken, Eigenarten von Betriebssystemen etc. recherchieren zu können,
um sich nicht rein auf Trainingsdaten verlassen zu müssen. Dies ist eine Ergänzung
zum bereits implementierten lokalen Memory-System.

Architektur, genutzte Gemini-API-Tools, Antwortformat und technische
Referenzen: siehe [specs.md](./specs.md). Installation und Registrierung:
siehe [README.md](./README.md).

## Nutzungsrahmen — WICHTIG

**Dieser MCP wird ausschließlich für Research- und Rechercheanfragen genutzt.**
Kein produktiver Einsatz, keine automatisierten Agentenketten ohne Kontrolle,
keine Anbindung an sensible Systeme (kein CRM, keine Firmendaten, keine Zahlungen).
Der Server dient nur dazu, Claude bei Bedarf eine aktuelle Websuche via Gemini
durchführen zu lassen.

## Verhaltensregeln für Claude Code in diesem Projekt

**Modellwahl und Thinking-Level:**

- Welches Modell und Thinking-Level ein `gemini-search`-Aufruf tatsächlich genutzt hat, muss für mich als User **immer sichtbar** sein — dafür steht es im Antwort-Footer (siehe specs.md). Ich soll nie raten müssen, was verwendet wurde
- Standardmäßig den gespeicherten Standard (Modell + Thinking-Level aus `config.json`) nutzen und bei `gemini-search` nichts explizit setzen, außer ich fordere für diesen einen Aufruf ausdrücklich etwas Abweichendes
- Kein automatisches Fallback auf ein anderes Modell ohne Rückfrage
- Vor einer Modelländerung immer zuerst `gemini-list-models` aufrufen, um zu
  prüfen, ob das gewünschte Modell tatsächlich verfügbar ist
- `gemini-set-model` nur nach expliziter Anweisung durch mich nutzen, nie
  eigenständig das Standardmodell wechseln
- Nach einer Änderung kurz bestätigen, welches Modell ab jetzt als Standard aktiv ist

**API-Key-Sicherheit:**

Die `config.json` speichert ausschließlich den Modellnamen — niemals den
API-Key oder andere sensible Daten. Der API-Key bleibt ausschließlich über
die Umgebungsvariable `GEMINI_API_KEY` verwaltet.

**Quellenliste und Footer:**

Quellenliste und Footer werden bei jedem Aufruf von `gemini-search`
automatisch angehängt und dürfen nicht entfernt oder umformuliert werden —
sie dienen der Transparenz über die genutzten Quellen und den tatsächlichen
Ressourcenverbrauch jedes einzelnen Tool-Calls.

**Fehlerbehandlung:**

Bei Fehlern in der API-Antwort den Fehler klar melden, keine Fallback-Modelle
automatisch ausprobieren.
