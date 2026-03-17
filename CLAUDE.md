# CLAUDE.md — NBU Control Room

## Progetto

NBU Control Room è un tool di morning check per una flotta di 7+ master server NetBackup gestiti da Roberto Novara (Mauden S.r.L.) per clienti bancari (Intesa Sanpaolo, Crédit Agricole, Fideuram, CIB Hungary, BIB).

L'ambiente è bancario: non si può hostare nulla internamente. Il tool è composto da:
- Uno script bash (`controlli.sh` / `nbu_morningcheck.sh`) che gira sui master NBU e produce output key=value
- Un wrapper bash (`control.sh` / `nbu_morningcheck_all.sh`) che dalla macchina Ansible fa SSH su tutti i master e raccoglie l'output in un unico file
- Un dashboard React statico su Netlify che parsa i file e mostra semafori

## Struttura repository

```
src/App.jsx          — Dashboard React (unico componente, include parser, RTF stripper, severity logic, UI)
src/main.jsx         — Entry point React
index.html           — HTML wrapper
vite.config.js       — Vite config
netlify.toml         — Netlify deploy config
package.json         — Dipendenze (react, vite)

# NON nel repo ma parte del progetto:
controlli.sh         — Script check NBU (va su ogni master in /root/controlli.sh)
control.sh           — Wrapper SSH (va sulla macchina Ansible in /root/control.sh)
```

## Convenzioni

- Lo script `controlli.sh` deve avere ZERO dipendenze esterne (no jq, no python) — solo bash e binari NBU standard
- Output formato key=value, sezioni separate da `---SECTION=xxx---`, fine report con `---END---`
- Multi-report in un unico file separati da `===MASTER_REPORT===`
- Il dashboard supporta sia .txt puliti che .rtf da MobaXterm (strip automatico)
- Severity nel dashboard: `ok` (verde), `warning` (giallo), `critical` (rosso), `error` (rosso)

## Decisioni di design e gotcha

### bperror -backstat parsing
Il campo $4 è severity (0=success, 2-4=info, 8=warning, 16+=error), NON lo status del job.
Il campo $6 è jobid: 0 = evento di sistema (nbpem CORBA, EMM up/down), >0 = job di backup reale.
I "backup failures" contano solo severity>=16 AND jobid>0.
I "system errors" sono severity>=16 AND jobid=0 — rumore operativo (nbpem CORBA status=25, EMM events, bprd socket errors).

### Media server detection
`nbemmcmd -listhosts -machinetype media` (formato NON parsable) produce righe tipo `media sglmop30`, `ndmp ceddd09-bk491`, `server nbumaster02`.
Lo script testa con `bptestbpcd` (timeout 5s) solo i `media`, skippa `ndmp` (appliance) e `server`/`cluster` (master stesso).
NON usare `-parsable` — il formato è `EMMHOST10.4.0.1 - hostname - ...` ed è inaffidabile.

### CLOSE-WAIT 1556
`nbinlinerwdetect` in CLOSE-WAIT sulla porta 1556 è NOTO INNOCUO — non va flaggato.
Solo CLOSE-WAIT di processi core (nbemm, bprd, bpdbm) è critico — indica il bug dell'incidente albmasterp01 di marzo 2026.

### Vault & Tapes
`vmquery` fallisce se non c'è tape library → lo script segna `VAULT_TAPES_STATUS=NA`, il dashboard lo mostra come OK verde con "N/A — No tape library".

### RTF stripper
MobaXterm salva output come RTF. I control codes (`\cf1\highlight2`) possono essere attaccati ai valori senza spazi. Lo stripper fa 3 passate di regex per catturarli tutti. Gestisce anche `\uNNNN?` unicode escapes.

### Timeout
Il wrapper SSH ha un timeout globale di 300s per master (configurabile `MASTER_TIMEOUT`). Master con molti media server (nbumaster02: 26, kopmasterp01: sconosciuto) possono essere lenti per i `bptestbpcd`.

### NBU version differences
- NBU 10.4.x (albmaster, nbumaster02, kop, romm, vub): `bpdbjobs -report -most_columns` funziona, NO `-hoursago`, NO `-statefilter`
- NBU 8.3.x (bibmaster, cibmaster): ambiente legacy, stessi comandi base funzionano

## Comandi utili per debug

```bash
# Lanciare lo script su un singolo master da remoto
time ssh root@nbumaster02 /root/controlli.sh > /tmp/test_nbumaster02.txt

# Verificare cosa c'è sul master
ssh root@nbumaster02 "head -5 /root/controlli.sh"

# Contare media server di un master
ssh root@kopmasterp01 "nbemmcmd -listhosts -machinetype media 2>/dev/null | grep -c '^media'"

# Test manuale bptestbpcd
ssh root@nbumaster02 "timeout 5 /usr/openv/netbackup/bin/bptestbpcd -client sglmop30"
```

## Macchina Ansible

- Hostname: `salclp0468` (OSANSIBLE01)
- OS: RHEL 7.9
- SSH key-based auth come root verso tutti i master
- Script wrapper: `/root/control.sh`
- Script check (copia locale): `/root/controlli.sh`
- Output: `/tmp/nbu_morningcheck_all.txt` (fisso, si sovrascrive)

## Deploy Netlify

- Sito: controlroomnbu.netlify.app
- Repo: github.com/Pl1n10/Control_room
- Branch: main
- Build: `npm run build` → `dist/`
- Auto-deploy al push
- Se netlify.toml dà problemi: configurare build settings dalla UI di Netlify e rimuovere il file dal repo
