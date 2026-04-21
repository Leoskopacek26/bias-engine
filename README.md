# Fundamental Bias Engine — Nasazení na Netlify

## Struktura projektu
```
bias-engine-project/
├── index.html              ← hlavní dashboard
├── netlify.toml            ← konfigurace Netlify
├── README.md               ← tento soubor
└── netlify/
    └── functions/
        └── macro.js        ← serverová funkce pro data
```

## Jak nasadit (5 kroků)

### 1. Vytvoř GitHub účet
Jdi na **github.com** → Sign up → zaregistruj se (zdarma)

### 2. Vytvoř nový repozitář
- Klikni na zelené tlačítko "New" vlevo nahoře
- Název: `bias-engine` (nebo cokoliv)
- Nechej jako Public
- Klikni "Create repository"

### 3. Nahraj soubory
- Klikni "uploading an existing file"
- Přetáhni VŠECHNY soubory z této složky (včetně podsložek)
- Klikni "Commit changes"

### 4. Propoj s Netlify
- Jdi na **netlify.com** → přihlas se svým Netlify účtem
- Klikni "Add new site" → "Import an existing project"
- Vyber GitHub → autorizuj → vyber repozitář `bias-engine`
- Klikni "Deploy site"

### 5. Hotovo!
Netlify automaticky nasadí vše včetně serverové funkce.
Tvůj web bude na adrese jako: `https://amazing-name-123.netlify.app`

## Co serverová funkce dělá
Každých 30 minut automaticky stahuje:
- **FX kurzy** — Frankfurter.app (ECB referenční kurzy)
- **US 10Y výnosy** — FRED (Federal Reserve)
- **VIX** — Yahoo Finance
- **DXY změna** — odvozeno z EUR/USD pohybu
