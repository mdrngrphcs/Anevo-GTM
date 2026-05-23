# Anevo-GTM

B2B outbound data procurement pipeline for Anevo Marketing. Pulls targeted contact lists from data sources (AI Ark, Apollo), verifies emails, enriches records with AI, and produces QA-flagged final CSVs ready for outbound sequences.

---

## What It Does

1. **Pull** — Searches a data source (AI Ark or Apollo) using ICP filters (titles, location, industry, headcount) and retrieves matching contacts with emails.
2. **Validate** — Runs every email through MillionVerifier to classify as valid, catch-all, or invalid.
3. **Enrich** — For each contact with a valid email, uses OpenAI and OpenRouter to generate a website summary, ICP classification, business type label, and additional decision maker.
4. **QA Flag** — Scores each record against a checklist of data quality criteria and marks it `approved` or `needs_review` with specific flag reasons.

---

## Folder Structure

```
Anevo-GTM/
├── scripts/
│   ├── run-pipeline.js          # Main pipeline runner
│   ├── apollo/
│   │   ├── job-config.js        # Creates and queues a job
│   │   ├── apollo-pull.js       # Pulls contacts from Apollo
│   │   ├── email-validation.js  # MillionVerifier email check
│   │   ├── ai-enrichment.js     # AI website summary + classification
│   │   └── qa-flagging.js       # QA scoring + final CSV output
│   └── aiark/
│       └── aiark-pull.js        # Pulls contacts from AI Ark
├── testing/
│   └── sample-job.js            # Example job config for testing
├── data/
│   ├── raw/                     # Raw CSVs from data source pull
│   ├── cleaned/                 # Email-validated CSVs
│   ├── enriched/                # AI-enriched CSVs
│   └── final/                   # QA-flagged output CSVs
├── jobs/
│   ├── queued/                  # Jobs waiting to run
│   ├── processing/              # Jobs currently running
│   ├── completed/               # Finished jobs
│   └── failed/                  # Failed jobs
├── logs/                        # Per-step log files
├── clients/                     # Client-specific configs (optional)
├── config/                      # Shared config files (optional)
├── prompts/                     # Prompt templates (optional)
├── templates/                   # Output templates (optional)
├── .env.example                 # API key template — copy to .env
├── package.json
└── README.md
```

---

## Installation

**Requirements:** Node.js 18+

```bash
git clone <your-repo-url>
cd Anevo-GTM
npm install
cp .env.example .env
```

Then open `.env` and fill in your real API keys (see [Configuration](#configuration) below).

---

## Configuration

Copy `.env.example` to `.env` and set the following keys:

| Variable | Source | Required |
|----------|--------|----------|
| `AI_ARK_API_KEY` | [ai-ark.com](https://ai-ark.com) | For AI Ark pulls |
| `APOLLO_API_KEY` | [apollo.io](https://apollo.io) | For Apollo pulls |
| `LISTMINT_API_KEY` | ListMint | Optional |
| `MILLIONVERIFIER_API_KEY` | [millionverifier.com](https://millionverifier.com) | Email validation |
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) | AI enrichment |
| `OPENROUTER_API_KEY` | [openrouter.ai](https://openrouter.ai) | AI enrichment (ICP classification) |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) | Reserved |

---

## Creating a Job Config

A job config is a plain JavaScript file that calls `createJob()` with your ICP parameters. See [testing/sample-job.js](testing/sample-job.js) for a full example.

```js
const { createJob } = require("../scripts/apollo/job-config");

createJob({
  clientName: "Acme Corp",          // Used to name output files
  listName: "Q3_Toronto_CROs",      // Used to name output files
  source: "aiark",                  // "aiark" or "apollo"

  icp: {
    titles: ["Chief Revenue Officer", "CRO"],
    industries: ["Computer Software", "SaaS"],
    headcount: { min: 10, max: 200 },
    location: ["Toronto, Ontario, Canada"],
    revenue: {},                    // Optional: { min: 1000000, max: 50000000 }
    technologies: [],               // Optional: ["Salesforce", "HubSpot"]
  },

  enrichments: {
    websiteSummary: true,
    icpClassification: true,
    businessLabeling: true,
    decisionMakerDiscovery: true,
  },

  outputDestination: "data/final",
});
```

Save the file anywhere (e.g. `testing/my-job.js`) and pass it to the pipeline runner.

---

## Running the Pipeline

```bash
node scripts/run-pipeline.js testing/sample-job.js
```

Replace `testing/sample-job.js` with the path to your job config file.

The pipeline runs five steps in sequence:

| Step | Script | What it does |
|------|--------|--------------|
| 1 | job config file | Validates config and writes a job JSON to `jobs/queued/` |
| 2 | `aiark-pull.js` or `apollo-pull.js` | Pulls contacts and finds emails via webhook |
| 3 | `email-validation.js` | Verifies each email with MillionVerifier |
| 4 | `ai-enrichment.js` | Enriches valid-email contacts with AI |
| 5 | `qa-flagging.js` | QA-scores records and writes final CSV to `data/final/` |

### Output

Final CSV lands in `data/final/` named `ClientName_ListName_M_DD_YY.csv` with columns:

```
first_name, last_name, title, email, email_status, phone, linkedin_url,
company, company_website, company_linkedin, industry, headcount,
city, state, country, Result, Result (1), Valid Email,
website_summary, icp_classification, business_type,
additional_decision_makers, qa_flags, qa_status
```

Records are marked `approved` (all checks pass) or `needs_review` (one or more flags).

### Log Files

Each step writes its own dated log file in `logs/`:
- `pipeline-YYYY-MM-DD.log`
- `aiark-pull-YYYY-MM-DD.log`
- `email-validation-YYYY-MM-DD.log`
- `ai-enrichment-YYYY-MM-DD.log`
- `qa-flagging-YYYY-MM-DD.log`

---

## Notes

- The AI Ark email finder uses a localtunnel webhook to receive results. Ensure outbound HTTPS is allowed from the machine running the pipeline.
- AI enrichment only runs on contacts with a **valid email** — invalid and catch-all emails are skipped.
- The pipeline reprocesses all existing files in `data/raw/`, `data/cleaned/`, and `data/enriched/` on each run. To run a single job in isolation, clear those directories first or run the individual step scripts directly.
