// Belegmarker ([1], [2]) fuer den Antworttext. Die Gemini-API weist ueber
// groundingSupports aus, welche Textstelle durch welche Quelle gestuetzt ist;
// diese Datei setzt daraus Marker in den Text. Sichtbar werden soll dabei
// weniger, WELCHE Quelle einen Satz stuetzt, als vielmehr, OB er ueberhaupt
// belegt ist - gemessen an einer realen Antwort waren 27 % des Textes durch
// keinen einzigen Support gedeckt, ohne dass man es der Antwort ansah.
//
// Die Datei greift bewusst weder auf die API noch auf die Konfiguration zu:
// Sie bekommt Text und Metadaten uebergeben und liefert Text zurueck. Damit
// ist sie ohne Netzwerk und ohne API-Key pruefbar (test/citations.test.js).
//
// Bei strenger Lesart stellt sich hier eine Frage aus Googles Terms: Sie
// untersagen es, "any other content" zwischen die Grounded Results zu mischen,
// und genau das tun die Marker. Die Entlastung ist dieselbe Quelle, auf die
// dieser Kommentar wegen des Byte-Offset-Fehlers ohnehin verweist - Googles
// eigene Referenzimplementierung in der Gemini CLI setzt die Marker genauso.
// Wenn Google das Verfahren selbst vorfuehrt, meint die Klausel nicht es,
// sondern fremde Inhalte wie Werbung. Die Marker verweisen ausserdem auf die
// mitgelieferten Links, statt von ihnen wegzufuehren.
//
// Gerechnet wird durchgehend in BYTES, nicht in Zeichen: startIndex und
// endIndex sind laut Typdefinition "measured in bytes". Bei einer deutschen
// Testantwort stimmte keine einzige von 28 Positionen zeichenbasiert, alle 28
// bytebasiert; Text und Bytes liefen am Ende um 44 Stellen auseinander. Google
// selbst hatte diesen Fehler in der Gemini CLI (PR google-gemini/
// gemini-cli#5956, aufgefallen an japanischem Text).

/**
 * Findet die Bereiche, in die kein Marker gesetzt werden darf: Markdown-Code
 * im Fliesstext. Ein Marker mitten in einem Codebeispiel macht aus
 * `copy.replace(obj, x=1)` ein `copy.replace(obj[3], x=1)` - syntaktisch
 * gueltig, inhaltlich falsch. Da gegen die Antworten dieses Servers Code
 * geschrieben wird, wiegt das schwerer als ein fehlender Marker.
 *
 * Gemeint ist NUR Code, den das Modell selbst in seinen Fliesstext schreibt.
 * Die Bloecke aus Code Execution sind eigene Parts, werden von buildText()
 * erst nach dem Einfuegen angehaengt und koennen hier nicht auftauchen.
 *
 * Gesucht wird in EINEM Durchlauf. Der Scan laeuft von links nach rechts, und
 * weil die umzaeunten Bloecke in der Alternation vorn stehen, verschluckt ein
 * Zaun alles, was in ihm steht - auch einzelne Backticks, die sonst als
 * Inline-Code gelesen wuerden. Eine zweite Suche mit Ueberlappungspruefung
 * braucht es dadurch nicht.
 *
 * Verworfen wurde die einfachere Variante, die Backticks vor der Zielposition
 * zu zaehlen und bei ungerader Anzahl zu verwerfen: Ein einzelner unpaariger
 * Backtick im Text kippt diese Zaehlung fuer den gesamten Rest, ein mit vier
 * Backticks geschlossener Block ebenso, und innerhalb einer Backtick-Sequenz
 * oszilliert sie bedeutungslos.
 *
 * Nicht erkannt werden eingerueckte Codebloecke (vier Leerzeichen). Sie sind
 * die einzige bekannte Luecke; nachruestbar als dritte Regel, falls sie in
 * echten Antworten auftauchen.
 *
 * Rueckgabe sind BYTE-Bereiche, passend zu den Offsets der API.
 */
function findCodeRanges(text) {
  const toByte = (charIndex) => Buffer.byteLength(text.slice(0, charIndex), "utf8");

  return [...text.matchAll(/```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]+`/g)].map((match) => [
    toByte(match.index),
    toByte(match.index + match[0].length),
  ]);
}

/**
 * Setzt Belegmarker in den Text EINES Parts.
 *
 * - text:         der Rohtext genau eines Text-Parts
 * - supports:     die groundingSupports, die zu DIESEM Part gehoeren
 * - chunkNumbers: Map vom Index in groundingChunks auf die Nummer in der
 *                 ausgegebenen Quellenliste (siehe buildSourceList)
 *
 * Liefert den Text mit Markern und die Zahl der verworfenen Marker. Verworfen
 * wird bewusst grosszuegig: Ein fehlender Marker laesst eine belegte Aussage
 * unbelegt wirken und loest damit nur zusaetzliche Vorsicht aus. Ein falsch
 * gesetzter Marker verweist auf eine Quelle, die die Aussage nicht stuetzt -
 * oder zerstoert Code. Deshalb im Zweifel immer gegen den Marker.
 */
export function insertCitations({ text, supports, chunkNumbers }) {
  if (!text || supports.length === 0) return { text, dropped: 0 };

  const bytes = Buffer.from(text, "utf8");
  const codeRanges = findCodeRanges(text);
  const insertions = [];
  let dropped = 0;

  for (const support of supports) {
    const segment = support.segment ?? {};
    const end = segment.endIndex;
    if (typeof end !== "number") continue;

    // Protobuf laesst Defaultwerte weg: startIndex fehlt im JSON, wenn er 0
    // ist. Ohne ?? 0 ergaebe die Pruefung darunter NaN und schluege immer fehl.
    const start = segment.startIndex ?? 0;

    // Die einzige Absicherung gegen eine stille Aenderung der
    // Offset-Semantik: Die API liefert den erwarteten Ausschnitt in
    // segment.text mit. Passt er nicht zur berechneten Position, wird nicht
    // geraten, sondern der Marker weggelassen. Damit kann ein Marker nie an
    // der falschen Stelle landen - er kann nur fehlen.
    if (segment.text !== undefined && bytes.subarray(start, end).toString("utf8") !== segment.text) {
      dropped++;
      continue;
    }

    if (codeRanges.some(([from, to]) => end > from && end < to)) {
      dropped++;
      continue;
    }

    // groundingChunkIndices verweist auf die UNDEDUPLIZIERTE Trefferliste der
    // API - gemessen 14 Treffer bei nur 4 eindeutigen URLs. Ein naives
    // index + 1 schriebe damit Nummern bis [14] in eine Liste mit vier
    // Eintraegen. chunkNumbers uebersetzt; Treffer, die es nicht in die Liste
    // geschafft haben, erzeugen keinen Marker.
    const numbers = [
      ...new Set(
        (support.groundingChunkIndices ?? [])
          .map((index) => chunkNumbers.get(index))
          .filter((number) => number !== undefined),
      ),
    ].sort((a, b) => a - b);

    // Kein dropped++: Hier gab es nichts zu setzen, nichts ging verloren.
    if (numbers.length === 0) continue;

    insertions.push({ index: end, marker: numbers.map((n) => `[${n}]`).join("") });
  }

  if (insertions.length === 0) return { text, dropped };

  // Von hinten nach vorn, damit bereits eingesetzte Zeichen die noch
  // ausstehenden Positionen nicht verschieben.
  insertions.sort((a, b) => b.index - a.index);

  // Die Bytestuecke werden gesammelt und EINMAL zusammengesetzt, statt bei
  // jedem Marker einen neuen Puffer zu bauen (Muster aus Googles
  // Referenzimplementierung). Buffer statt TextEncoder/Uint8Array: identische
  // Byte-Semantik, aber kuerzer - der Server laeuft ausschliesslich unter
  // Node, die Portabilitaet, wegen der Google dort TextEncoder nutzt, wird
  // hier nicht gebraucht.
  const chunks = [];
  let lastIndex = bytes.length;
  for (const { index, marker } of insertions) {
    // Faengt einen Offset ab, der ueber das Textende hinausweist - sonst
    // entstuende ein leeres subarray und der Marker landete am falschen Ort.
    const position = Math.min(index, lastIndex);
    chunks.unshift(bytes.subarray(position, lastIndex));
    chunks.unshift(Buffer.from(marker, "utf8"));
    lastIndex = position;
  }
  chunks.unshift(bytes.subarray(0, lastIndex));

  return { text: Buffer.concat(chunks).toString("utf8"), dropped };
}
