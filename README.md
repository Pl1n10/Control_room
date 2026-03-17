# NBU Control Room

Dashboard per il morning check della flotta NetBackup. Raccoglie lo stato di salute di tutti i master server in un unico file e lo visualizza in una dashboard web stile NOC/control room.

**Live:** [controlroomnbu.netlify.app](https://controlroomnbu.netlify.app)

## Architettura

```
┌─────────────────┐     SSH      ┌──────────────────┐
│  Ansible Box    │─────────────▶│  NBU Master 1    │
│  (salclp0468)   │              │  controlli.sh    │
│                 │─────────────▶│  NBU Master 2    │
│  control.sh     │     ...      │  ...             │
│  (wrapper)      │─────────────▶│  NBU Master N    │
└────────┬────────┘              └──────────────────┘
         │
         │ /tmp/nbu_morningcheck_all.txt
         │ (unico file, tutti i report)
         ▼
┌─────────────────┐    drag&drop  ┌──────────────────┐
│  PC operatore   │─────────────▶│  Dashboard React │
│  (MobaXterm)    │              │  Netlify (statico)│
└─────────────────┘              └──────────────────┘
```

Zero hosting in ambiente bancario. Lo script gira sui master, il dashboard è un sito statico su Netlify.

## Componenti

| File | Dove va | Scopo |
|------|---------|-------|
| `controlli.sh` | Ogni NBU master (`/root/controlli.sh`) | Esegue i check e sputa output key=value |
| `control.sh` | Macchina Ansible (`/root/control.sh`) | Wrapper SSH: lancia controlli.sh su tutti i master, raccoglie output in un unico file |
| `src/App.jsx` | Netlify (dashboard web) | Parsa i file (txt o RTF), mostra semafori per master |

## Quick Start

### 1. Deploy dello script check sui master

Dalla macchina Ansible:

```bash
# Copia controlli.sh sulla macchina Ansible
vi /root/controlli.sh   # incolla il contenuto di nbu_morningcheck.sh
chmod +x /root/controlli.sh

# Distribuisci a tutti i master
for m in nbumaster02 albmasterp01 kopmasterp01 rommasterp01 vubmasterp01 bibmaster cibmaster; do
    scp /root/controlli.sh root@$m:/root/controlli.sh
done
```

### 2. Deploy del wrapper sulla macchina Ansible

```bash
vi /root/control.sh   # incolla il contenuto di nbu_morningcheck_all.sh
chmod +x /root/control.sh
```

### 3. Lancio del morning check

```bash
./control.sh
```

Output: `/tmp/nbu_morningcheck_all.txt` (file fisso, si sovrascrive ogni run).

### 4. Visualizzazione

1. Copia `/tmp/nbu_morningcheck_all.txt` sul tuo PC (SCP, MobaXterm, ecc.)
2. Apri [controlroomnbu.netlify.app](https://controlroomnbu.netlify.app)
3. Trascina il file nella drop zone
4. Tutti i master appaiono con semafori

## Check eseguiti

| # | Check | Cosa guarda | Severity |
|---|-------|-------------|----------|
| 1 | **Failed Jobs** | `bperror -backstat -hoursago 24 -all`, classifica per severity ($4) e jobid ($6). Separa backup failures (jobid>0) da system errors (jobid=0) | 🔴 >5 backup failures, 🟡 >50 system errors |
| 2 | **Hung Jobs** | `bpdbjobs -report -most_columns`, cerca job attivi >24h o in coda >6h | 🔴 ≥3, 🟡 1-2 |
| 3 | **Disk Pools** | `nbdevquery -listdp -U`, capacity per ogni pool | 🔴 >95%, 🟡 >80% |
| 4 | **Media Servers** | `nbemmcmd -listhosts`, poi `bptestbpcd` solo sui veri media server (skip NDMP, skip master) | 🔴 qualsiasi DOWN |
| 5 | **Certificates** | `nbcertcmd -listCertDetails`, parsing date scadenza | 🔴 <7gg, 🟡 <30gg |
| 6 | **Vault & Tapes** | `vmquery -a -bx`, conta scratch/frozen/expired. Se non c'è tape library → N/A | 🔴 scratch<5, 🟡 scratch<20 |
| 7 | **Daemon Health** | `pgrep` per nbemm, nbpem, bprd, bpdbm, bpjobd, nbaudit, vnetd, nbjm, nbrb. CLOSE-WAIT su porta 1556 (esclude nbinlinerwdetect che è innocuo) | 🔴 demoni down o CLOSE-WAIT core |
| 8 | **System** | uptime, load, RAM, swap, spazio catalogo e DB | 🔴 >95%, 🟡 >85% |

## Formato output

Lo script produce output key=value puro, zero dipendenze:

```
REPORT_VERSION=2
MASTER_HOSTNAME=sc11nalbmasterp01
TIMESTAMP=2026-03-16T13:15:00+0100
---SECTION=FAILED_JOBS---
FAILED_JOBS_STATUS=OK
FAILED_JOBS_FAILED=0
FAILED_JOBS_SYSTEM_ERRORS=925
---SECTION=DAEMON_HEALTH---
DAEMON_nbemm_STATUS=UP
CLOSEWAIT_1556_COUNT=0
CLOSEWAIT_1556_SEVERITY=OK
---END---
```

Il wrapper concatena i report separandoli con `===MASTER_REPORT===`.

Il dashboard supporta sia file `.txt` puliti che `.rtf` da MobaXterm (strip automatico del markup RTF).

## Fleet attuale

| Master | Ambiente | NBU Version | Note |
|--------|----------|-------------|------|
| nbumaster02 (ispnbucap01) | ISP | 10.4.0.1 | 26 media server, 23 disk pool, ambiente grosso |
| albmasterp01 (sc11nalbmasterp01) | Albania | 10.4.0.1 | Post-incidente nbemm zombie Mar 2026 |
| kopmasterp01 | Kopernikus | 10.4.0.1 | Script lento (molti media server), timeout 300s |
| rommasterp01 (sc11nrommasterp01) | Romania | 10.4.0.1 | |
| vubmasterp01 (sc11nvubmasterp01) | VUB | 10.4.0.1 | Client AIX con file shrunk warning |
| bibmaster (bibnbup02) | BIB | 8.3.0.2 | Ambiente legacy |
| cibmaster (cibnbup02) | CIB | 8.3.0.2 | Ambiente legacy, client non raggiungibili |

## Sviluppo dashboard

```bash
npm install
npm run dev      # dev server locale
npm run build    # build produzione → dist/
```

Deploy automatico su Netlify al push su `main`.

## Troubleshooting

**Lo script è lento su un master:** troppe media server con `bptestbpcd` timeout 5s ciascuno. Il wrapper ha un timeout globale di 300s per master.

**Il dashboard mostra il nome file invece dell'hostname:** lo stripper RTF non ha rimosso tutti i control codes. Usare file .txt quando possibile.

**`vmquery command failed`:** il master non ha tape library → lo script segna N/A, non è un errore.

**CLOSE-WAIT su 1556:** se è solo `nbinlinerwdetect` → innocuo (noto). Se è nbemm o altri core daemon → critico, seguire procedura post-incidente nel context file albmasterp01.
