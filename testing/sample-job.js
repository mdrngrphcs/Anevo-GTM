const { createJob } = require("../scripts/apollo/job-config");

const sampleConfig = {
  clientName: "TestClient",
  listName: "Toronto_CRO_SaaS",
  source: "aiark",

  icp: {
    titles: ["Chief Revenue Officer", "CRO"],
    industries: ["Computer Software", "SaaS"],
    headcount: { min: 10, max: 50 },
    location: ["Toronto, Ontario, Canada"],
    revenue: {},
    technologies: [],
  },

  enrichments: {
    websiteSummary: true,
    icpClassification: true,
    businessLabeling: true,
    decisionMakerDiscovery: true,
  },

  outputDestination: "data/final",
};

createJob(sampleConfig);
