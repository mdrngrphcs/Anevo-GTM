const { createJob } = require("../scripts/apollo/job-config");

const sampleConfig = {
  clientName: "Acme Corp",
  listName: "Q2 SaaS AI Ark",
  source: "aiark",

  icp: {
    titles: ["VP of Sales", "Head of Revenue", "Chief Revenue Officer", "Sales Director"],
    industries: ["Software", "SaaS", "Cloud Computing", "Information Technology"],
    companyKeywords: ["CRM", "revenue operations", "sales enablement"],
    headcount: { min: 50, max: 500 },
    location: ["United States", "Canada"],
    revenue: { min: 5000000, max: 100000000 },
    technologies: ["Salesforce", "HubSpot", "Outreach"],
  },

  enrichments: {
    websiteSummary: true,
    icpClassification: true,
    businessLabeling: false,
    decisionMakerDiscovery: true,
  },

  outputDestination: "data/final",
};

createJob(sampleConfig);
