# Fade Studio

Sanfte, animierte Lichtabläufe für Home Assistant – geplant auf einer Zeitleiste mit einer Spur pro Lampe, wie in einem Videoschnittprogramm.

![Zeitleiste](docs/screenshot.png)

## Idee

Fade Studio ist **nur ein Editor** (eine Dashboard-Karte). Beim Speichern entstehen ganz normale Home-Assistant-Bausteine:

| Was | Wofür |
|---|---|
| `script.fade_studio_<name>` | spielt den Ablauf ab (die Zeitleiste steckt als `variables` im Skript) |
| `input_number.fade_studio_<name>_dimmer` | Gesamthelligkeit des Ablaufs – alle Lampen im Verhältnis |
| Label **Fade Studio** | markiert alles, was die Karte erzeugt hat |

Abgespielt wird ausschließlich von Home Assistant selbst. Jeder Abschnitt der Zeitleiste ist **ein** `light.turn_on` mit `transition` – die Lampe (Hue, Zigbee, Matter) überblendet selbst. Das ist weich und belastet das Funknetz kaum.

## Funktionen

- Spuren pro Lampe oder Gruppe, Punkte per Klick setzen und ziehen (Zeit ↔ Helligkeit)
- Modi pro Spur: **Weißton** (Kelvin), **Farbe**, **nur Helligkeit** – automatisch passend zur Lampe
- **IKEA-Modus**: erst Farbe, dann Helligkeit (für Lampen, die beides nicht gleichzeitig überblenden)
- Endlosschleife (nahtlos), Einblenden, Ende-Verhalten: vorherigen Zustand wiederherstellen, halten, ausblenden, Szene
- Gesamthelligkeit live regelbar – ohne Sprung (Restzeit wird neu berechnet)
- Vorlagen **☁ Ambient Drift** (ruhiges, zeitversetztes Gleiten) und **≈ Breathe** (sanftes Pulsieren, als Welle durch die Räume)
- „An Lampe zeigen“ für einzelne Punkte
- **Alles entfernen**: löscht alle Skripte, Helfer und das Label

## Installation

### HACS (benutzerdefiniertes Repository)
1. HACS → ⋮ → *Benutzerdefinierte Repositories* → URL dieses Repos, Typ **Dashboard**
2. „Fade Studio“ installieren, Browser neu laden

### Manuell
1. `dist/fade-studio-card.js` nach `/config/www/fade-studio-card.js` kopieren
2. Einstellungen → Dashboards → ⋮ → *Ressourcen* → `/local/fade-studio-card.js`, Typ *JavaScript-Modul*

### Karte anlegen
Einstellungen → Dashboards → *Dashboard hinzufügen* („Neues Dashboard von Grund auf“, z. B. „Licht-Abläufe“) → Ansicht bearbeiten → Ansichtstyp **Panel (einzelne Karte)** → Karte hinzufügen → *Manuell*:

```yaml
type: custom:fade-studio-card
```

Speichern erfordert Administratorrechte.

## Abläufe verwenden

```yaml
# starten (z. B. in einer Automation)
action: script.turn_on
target:
  entity_id: script.fade_studio_ambient_drift

# sanft beenden (mit dem eingestellten Ende-Verhalten)
action: script.turn_on
target:
  entity_id: script.fade_studio_ambient_drift
data:
  variables:
    finish: true

# Gesamthelligkeit
action: input_number.set_value
target:
  entity_id: input_number.fade_studio_ambient_drift_dimmer
data:
  value: 40
```

`script.turn_off` stoppt hart (ohne Ende-Verhalten).

## Entfernen

1. In der Karte **Alles entfernen**
2. Karte in HACS deinstallieren (bzw. Ressource und Datei löschen), Dashboard löschen

Danach bleibt nichts zurück.

## Grenzen

- Nach einem Neustart von Home Assistant laufen Abläufe nicht automatisch weiter (Automation mit `homeassistant`-Start-Trigger hilft).
- Der Schnappschuss für „vorherigen Zustand wiederherstellen“ überlebt keinen Neustart.
- Sehr kurze Abschnitte (< 2 s) mit vielen Lampen können Hue-Bridge/Zigbee überlasten. Fade Studio ist für ruhige Abläufe gedacht.
- Gespeichert wird über dieselbe Schnittstelle, die der Skript-Editor von Home Assistant nutzt.
