# PSC Docket Helper

An AI-assisted way to explore District of Columbia Public Service Commission news, utility dockets, regulatory filings, and public records.

## Try the Live Website

### [Open the PSC Docket Helper](https://psc-docket-helper.onrender.com/)

Explore recent regulatory updates or ask the PSC Assistant about a DC utility case. No installation is required.

> The PSC Docket Helper is a non-official experimental tool. Because the demo uses Render's free hosting tier, the first visit after a period of inactivity may take about a minute to load.

## What You Can Do

- **Follow recent PSC updates.** Browse current notices, meetings, hearings, and other regulatory news collected from the official DCPSC website.
- **Ask about a docket.** Enter a formal case number or ask a plain-language question about a utility proceeding.
- **Find official records.** Follow links back to DCPSC and e-Docket sources to review the underlying public information.
- **Keep inquiries organized.** Create separate conversations and return to recent chat sessions saved in your browser.

## Questions to Try

- `What is FC 1167 about?`
- `Show me recent utility rate cases.`
- `What are DC's renewable energy goals?`
- `Where can I find the official filings for a formal case?`

## Why This Project Exists

Public utility proceedings can involve long dockets, formal case numbers, technical filings, and information spread across multiple public systems. PSC Docket Helper provides a simpler starting point: users can ask a question in everyday language, review a concise explanation, and continue to the official source when they need the complete record.

## Information and Sources

The regulatory update cards are not AI-generated. The server retrieves news from the [DCPSC Current PSC News](https://dcpsc.org/Newsroom/Current-PSC-News.aspx) page and links users to official `dcpsc.org` records. Results are cached briefly for performance, with a bundled set of verified official links available if the source page is temporarily unavailable.

The PSC Assistant uses OpenAI for explanation and synthesis. Case facts and docket links are gathered from public DCPSC and [e-Docket](https://edocket.dcpsc.org/public/search) sources whenever available.

This project is not affiliated with or endorsed by the Public Service Commission of the District of Columbia. AI-generated explanations may be incomplete or inaccurate and should not be treated as legal advice or an official agency record. Verify important information against the original filing or the [official DCPSC website](https://dcpsc.org/).

## For Developers

The application uses React, TypeScript, Vite, Tailwind CSS, Express, and the OpenAI API. The Express server provides the API routes and serves the built frontend in production.

### Run Locally

Requirements:

- Node.js
- npm
- An OpenAI API key for AI-generated answers

```bash
npm install
export OPENAI_API_KEY="your_api_key_here"
npm run dev
```

Open [http://localhost:3000](http://localhost:3000). Without an OpenAI API key, the public news experience remains available and the assistant displays links to official search tools.

### Validate and Build

```bash
npm run lint
npm run build
npm start
```

### Deploy on Render

Create a Render Web Service connected to this repository and use:

```text
Build Command: npm install && npm run build
Start Command: npm start
```

Add `OPENAI_API_KEY` in the Render environment settings. Pushes to the connected branch will then trigger automatic deployments.
