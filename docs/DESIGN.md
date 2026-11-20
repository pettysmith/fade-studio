# Gestaltungsregeln

Diese Regeln gelten für jede Änderung an der Oberfläche.

## Grundsatz

- **Farbe gehört dem Inhalt und den Aktionen, nicht dem Dashboard.** Die Karte übernimmt keine Farben aus dem Home-Assistant-Theme. Aus dem Theme wird nur gelesen, ob es hell oder dunkel ist.
- Farbig ist nur zweierlei:
  1. **Lichttöne** der Lampen (der eigentliche Inhalt),
  2. **Orange** für „aktiv“: laufend, ausgewählt, eingeschaltet. Sonst nichts.
- Alles andere ist Weiß, Grau, Schwarz, Anthrazit.
- Keine Verläufe als Schmuck. Lichtverläufe werden als Raster aus einzelnen Feldern gezeigt (wie LEDs), nicht als weicher Verlauf.

## Zwei Zonen

| Zone | Was | Formensprache |
|---|---|---|
| **Sequenz** | Zeitleiste, Spuren, Lichtfelder, Pegel, Lineal, Abspiel-Strich | eigenständig: Raster, Punktgitter, Quadrate, Monospace, 1-px-Linien, Radius 0–2 px |
| **Rahmen** | Karte, Kopf, Transport, Parameter, Regler, Schalter, Dialoge, Listen | wie Home Assistant: Karte 12 px Radius, Tasten 10–12 px, Pillen-Schalter, runde Reglerknöpfe, Beschriftung in normaler Schrift (Satzschreibung) |

Die Farbregel gilt in beiden Zonen.

## Lichttöne sichtbar machen

- Weißtöne werden für die Anzeige auf eine gespreizte Skala abgebildet (Bernstein → Warmweiß → Neutral → Kühlblau), damit 2200 K und 3000 K klar unterscheidbar sind. An die Lampe geht weiterhin der echte Wert.
- Lichtfelder liegen immer auf einem dunklen Anzeigefeld (wie ein Display), auch im hellen Theme – so bleiben helle Töne erkennbar.
- Helligkeit ist Höhe oder Linie, nie Deckkraft.

## Längen

- Vorlagen sind kurz: Standard 20–40 s, höchstens 60 s.
- Die Länge lässt sich mit einem Tipp wählen (15 / 30 / 45 / 60 s) oder frei eingeben.

## Zwei Ansichten, ein Baukasten

| Ansicht | Wann | Zweck |
|---|---|---|
| **Fernbedienung** | schmal / hochkant | Abläufe wählen, starten, pausieren, stoppen, gemeinsam dimmen, sehen, was leuchtet |
| **Studio** | breit / querformat | Zeitleiste gestalten: Spuren, Punkte, Parameter |

Beide bestehen aus denselben Bausteinen: Bibliothek, Transport, Zeitleiste, Inspektor, Parameter. Kein Baustein existiert nur in einer Ansicht in anderer Form.

## System (verbindlich)

**Spalten**
- Linke Spalte `--col` = 240 px, überall gleich: Name, Spurnamen, Punkt-Inspektor, Transport-Tasten. Ihre rechte Kante ist eine durchgehende senkrechte Linie.
- Rechts davon der Inhalt (Parameter, Zeitleiste, Werte). Abstand zur Spalte 16 px.
- Außenabstand 24 px (breit) bzw. 16 px (schmal).

**Höhen** (Grundmaß 8 px; Linien zählen zur Höhe)
| Band | Höhe |
|---|---|
| Kopf links (Bibliothek) und Transport rechts | 72 px – gleich hoch, eine durchgehende Linie |
| Parameter | 72 px je Zeile (umbricht in ganzen Zeilen) |
| Lineal | 40 px |
| Spur | 88 px (Lichtdisplay 72 px) |
| Gruppenmitglied | 64 px (Lichtdisplay 48 px) |
| Spur hinzufügen | 56 px |
| Inspektor | 72 px Werte + 48 px Aktionen |
| Fuß links und rechts | 64 px – gleich hoch |
| Eintrag in der Bibliothek | 96 px |

**Zellenformel**: 12 px Rand + 16 px Beschriftung + 4 px + 40 px Bedienelement = 72 px.

**Bedienhöhen**: Tasten 48 · Felder und Knöpfe 40 · klein (Segmente, Chips, Aktionen) 32.

**Regler**: Schiene 4 px, Knopf 16 px, gefüllter Teil orange, kein Rahmen. **Fokus**: 2 px orange, 2 px Abstand.

**Schrift** (Größe / Gewicht)
| Rolle | |
|---|---|
| Zeitanzeige | 34 px Monospace |
| Titel | 16 px / 600 |
| Text, Werte | 14 px / 400–500 |
| Beschriftung Rahmen | 12 px, Satzschreibung |
| Beschriftung Sequenz, Hinweise | 10–11 px |

**Symbole** 18 px (klein), 20 px (normal), 24 px (Tasten).

**Einheiten** stehen immer hinter dem Wert, in Nebentextfarbe: `s`, `%`, `K`. Keine Werte ohne Einheit.

**Hinweise vs. Bedienelemente**
- Bedienelement mit Rahmen (Chip, Tag) = antippbar, ändert etwas.
- Reiner Hinweis (z. B. „nicht erreichbar“, „Gruppe · 3“) = kleine Schrift ohne Rahmen in der Namenszeile; verändert die Zeilenhöhe nie.

**Linien**
- Raster und Spalten sind fest; nichts verschiebt sich beim Bedienen (fester Spaltenabstand, reservierte Scrollleiste).

**Wortwahl**
- Ausgeschrieben und eindeutig: „Ikea-Leuchte erkannt“, „Ikea-Modus“, „Helligkeit auf alle Spuren übertragen“.

## Raster und Maße

- Grundmaß 8 px. Abstände 4 / 8 / 16 / 24 / 32.
- Linien 1 px. Flächen trennen sich durch Linien, nicht durch Schatten.
- Radien: Sequenz 0–2 px; Rahmen nach Home Assistant (Karte 12 px, Tasten 10–12 px, Schalter als Pille).
- Bedienelemente mindestens 40 px hoch (Touch).

## Schrift

- Text: Systemschrift (sans), 13–15 px.
- Zahlen und Zeit: Monospace mit gleichbreiten Ziffern.
- Beschriftungen in der Sequenz-Zone: Monospace, Großbuchstaben, 10 px, Laufweite +0,08 em. Im Rahmen: normale Schrift, 12 px, Satzschreibung.
- Zeitanzeige groß in Monospace.

## Bedienelemente

- **Schalter** = Pille wie in Home Assistant; an = orange, aus = grau.
- **Segmentwahl** = Textlabels, das aktive mit orangem Strich darunter.
- **Tasten** = abgerundete Quadrate (12 px), Symbol mittig. Play leuchtet orange, solange etwas läuft. Symbol-Tasten ohne Rahmen sind rund wie in Home Assistant.
- **Regler** = 4 px Schiene, runder Knopf; gefüllter Teil orange.
- **Punkte** in der Zeitleiste = kleine Quadrate, ausgewählt orange gefüllt.
- Symbole aus dem Home-Assistant-Iconset (MDI), keine Emojis.

## Farben

| Token | hell | dunkel |
|---|---|---|
| `--bg` Seite/Karte außen | `#e9e8e4` | `#0f0f0f` |
| `--panel` Fläche | `#f6f5f2` | `#1a1a1a` |
| `--well` vertiefte Fläche | `#ecebe7` | `#141414` |
| `--ink` Text | `#141414` | `#ececec` |
| `--ink-2` Nebentext | `#6e6d69` | `#8b8b8b` |
| `--line` Linie | `#d4d3ce` | `#2c2c2c` |
| `--acc` aktiv | `#ff5f1f` | `#ff6a26` |
| `--acc-ink` Text auf Orange | `#141414` | `#141414` |

## Verboten

Schatten als Schmuck, Verläufe als Schmuck, Emojis, mehrfarbige Statusfarben, doppelte Bedienwege für dieselbe Aktion, erklärende Fließtexte in der Oberfläche (dafür Tooltips).
