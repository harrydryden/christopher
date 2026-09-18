/**
 * Test fixtures. The two worked examples in the spec are an Anduril-style page (a JavaScript
 * shell whose roles arrive from a Greenhouse API call) and an Anthropic-style page (a careers
 * landing page that links on to a Greenhouse-backed listing). Hostnames use example.com so the
 * fixtures never imply a live endpoint.
 */

/**
 * The board listing as the adapter asks for it: `/jobs`, without `content=true`, so no posting
 * carries a description. Anduril's board answered that request in 1-2 MB where the same board
 * with `content=true` answered in 41 MB.
 */
export const GREENHOUSE_JOBS = {
  jobs: [
    {
      id: 4001001,
      internal_job_id: 3001,
      title: "Operations Manager",
      updated_at: "2026-08-30T09:00:00Z",
      first_published: "2026-08-28T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001",
      location: { name: "London, UK" },
      departments: [{ id: 1, name: "Operations" }],
      offices: [{ id: 1, name: "London" }],
      metadata: [{ name: "Salary Range", value: "£70,000 - £90,000" }],
    },
    {
      id: 4001002,
      title: "Senior Operations Associate",
      updated_at: "2026-09-01T09:00:00Z",
      first_published: "2026-09-01T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001002",
      location: { name: "Remote - USA" },
      departments: [{ id: 1, name: "Operations" }],
      offices: [{ id: 2, name: "Remote" }],
    },
    {
      id: 4001003,
      title: "Software Engineer, Platform",
      updated_at: "2026-08-15T09:00:00Z",
      first_published: "2026-08-10T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001003",
      location: { name: "London, UK" },
      departments: [{ id: 2, name: "Engineering" }],
      offices: [{ id: 1, name: "London" }],
    },
    {
      id: 4001004,
      title: "Head of Business Operations",
      updated_at: "2026-07-01T09:00:00Z",
      first_published: "2026-06-20T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001004",
      location: { name: "New York, NY" },
      departments: [{ id: 1, name: "Operations" }],
      offices: [{ id: 3, name: "New York" }],
    },
    {
      id: 4001005,
      title: "Operations Intern",
      updated_at: "2026-09-02T09:00:00Z",
      first_published: "2026-09-02T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001005",
      location: { name: "Manchester, UK" },
      departments: [{ id: 1, name: "Operations" }],
      offices: [{ id: 4, name: "Manchester" }],
    },
    {
      id: 4001006,
      title: "Recruiting Coordinator",
      updated_at: "2026-08-20T09:00:00Z",
      absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001006",
      location: { name: "Remote - UK" },
      departments: [{ id: 3, name: "People" }],
      offices: [],
    },
  ],
  meta: { total: 6 },
};

/** One role from `/v1/boards/{slug}/jobs/{id}`: the same fields plus the HTML description. */
export const GREENHOUSE_JOB_DETAIL = {
  id: 4001001,
  internal_job_id: 3001,
  title: "Operations Manager",
  updated_at: "2026-08-30T09:00:00Z",
  first_published: "2026-08-28T09:00:00Z",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001001",
  location: { name: "London, UK" },
  departments: [{ id: 1, name: "Operations" }],
  offices: [{ id: 1, name: "London" }],
  content: "&lt;p&gt;We are looking for an &lt;strong&gt;Operations Manager&lt;/strong&gt; in London.&lt;/p&gt;",
  metadata: [{ name: "Salary Range", value: "£70,000 - £90,000" }],
};

/** A posting the board has no description for: the detail response simply has no `content`. */
export const GREENHOUSE_JOB_DETAIL_NO_CONTENT = {
  id: 4001003,
  title: "Software Engineer, Platform",
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001003",
  location: { name: "London, UK" },
};

export const GREENHOUSE_BOARD = { name: "Acme Robotics", content: "About Acme" };

export const LEVER_POSTINGS = [
  {
    id: "e6a1f8c2-1111-4c1a-9f11-2f0a1b2c3d4e",
    text: "Operations Lead",
    categories: { commitment: "Full-time", department: "Operations", location: "London", team: "Ops", allLocations: ["London", "Bristol"] },
    description: "<p>Own operations end to end.</p>",
    descriptionPlain: "Own operations end to end.",
    hostedUrl: "https://jobs.lever.co/acme/e6a1f8c2-1111-4c1a-9f11-2f0a1b2c3d4e",
    applyUrl: "https://jobs.lever.co/acme/e6a1f8c2-1111-4c1a-9f11-2f0a1b2c3d4e/apply",
    createdAt: 1756377600000,
    workplaceType: "hybrid",
    country: "GB",
    salaryRange: { min: 70000, max: 90000, currency: "GBP", interval: "per-year-salary" },
  },
  {
    id: "b2c3d4e5-2222-4c1a-9f11-2f0a1b2c3d4e",
    text: "Data Scientist",
    categories: { commitment: "Full-time", department: "Data", location: "Remote", team: "Data" },
    descriptionPlain: "Analyse data.",
    hostedUrl: "https://jobs.lever.co/acme/b2c3d4e5-2222-4c1a-9f11-2f0a1b2c3d4e",
    createdAt: 1756291200000,
    workplaceType: "remote",
  },
];

export const ASHBY_BOARD = {
  apiVersion: "1",
  jobs: [
    {
      id: "9f0e1d2c-3333-4c1a-9f11-2f0a1b2c3d4e",
      title: "Operations Associate",
      department: "Operations",
      team: "Business Operations",
      employmentType: "FullTime",
      location: "London, United Kingdom",
      secondaryLocations: [{ location: "Dublin, Ireland" }],
      publishedAt: "2026-08-25T10:00:00.000Z",
      isListed: true,
      isRemote: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/9f0e1d2c-3333-4c1a-9f11-2f0a1b2c3d4e",
      applyUrl: "https://jobs.ashbyhq.com/acme/9f0e1d2c-3333-4c1a-9f11-2f0a1b2c3d4e/application",
      descriptionHtml: "<p>Support the operations team.</p>",
      descriptionPlain: "Support the operations team.",
      compensation: { scrapeableCompensationSalarySummary: "£55K – £65K" },
    },
    {
      id: "8e7d6c5b-4444-4c1a-9f11-2f0a1b2c3d4e",
      title: "Unlisted Draft Role",
      location: "London",
      isListed: false,
      jobUrl: "https://jobs.ashbyhq.com/acme/8e7d6c5b-4444-4c1a-9f11-2f0a1b2c3d4e",
    },
  ],
};

export const WORKDAY_PAGE_1 = {
  total: 25,
  jobPostings: Array.from({ length: 20 }, (_, i) => ({
    title: i === 0 ? "Operations Program Manager" : `Role ${i + 1}`,
    externalPath: `/job/London/Role-${i + 1}_R-100${i}`,
    locationsText: i === 0 ? "London, United Kingdom" : "New York, United States of America",
    postedOn: i === 0 ? "Posted 3 Days Ago" : "Posted 30+ Days Ago",
    bulletFields: [`R-100${i}`],
  })),
};

export const WORKDAY_PAGE_2 = {
  total: 25,
  jobPostings: Array.from({ length: 5 }, (_, i) => ({
    title: `Role ${i + 21}`,
    externalPath: `/job/London/Role-${i + 21}_R-200${i}`,
    locationsText: "London, United Kingdom; Manchester, United Kingdom",
    postedOn: "Posted Yesterday",
    bulletFields: [`R-200${i}`],
  })),
};

export const SMARTRECRUITERS_PAGE = {
  offset: 0,
  limit: 100,
  totalFound: 2,
  content: [
    {
      id: "744000000000001",
      uuid: "aaaa-bbbb",
      name: "Operations Coordinator",
      releasedDate: "2026-08-20T08:00:00.000Z",
      location: { city: "London", region: "England", country: "uk", remote: false, fullLocation: "London, England, uk" },
      department: { label: "Operations" },
      typeOfEmployment: { label: "Full-time" },
      ref: "https://api.smartrecruiters.com/v1/companies/acme/postings/744000000000001",
      company: { identifier: "acme", name: "Acme Robotics" },
    },
    {
      id: "744000000000002",
      name: "Account Executive",
      releasedDate: "2026-08-22T08:00:00.000Z",
      location: { city: "Berlin", country: "de", remote: true },
      department: { label: "Sales" },
      ref: "https://api.smartrecruiters.com/v1/companies/acme/postings/744000000000002",
      company: { identifier: "acme", name: "Acme Robotics" },
    },
  ],
};

export const SMARTRECRUITERS_DETAIL = {
  id: "744000000000001",
  jobAd: {
    sections: {
      jobDescription: { title: "Job Description", text: "<p>Coordinate day-to-day operations.</p>" },
      qualifications: { title: "Qualifications", text: "<p>3+ years in operations.</p>" },
    },
  },
};

export const RECRUITEE_OFFERS = {
  offers: [
    {
      id: 90001,
      slug: "operations-manager",
      title: "Operations Manager",
      careers_url: "https://acme.recruitee.com/o/operations-manager",
      department: "Operations",
      location: "London",
      city: "London",
      country: "United Kingdom",
      remote: false,
      published_at: "2026-08-18T00:00:00.000Z",
      description: "<p>Run operations.</p>",
      requirements: "<p>Experience required.</p>",
      status: "published",
      employment_type_code: "fulltime",
    },
    { id: 90002, slug: "draft-role", title: "Draft Role", status: "draft", careers_url: "https://acme.recruitee.com/o/draft-role" },
  ],
};

export const PERSONIO_XML = `<?xml version="1.0" encoding="utf-8"?>
<workzag-jobs>
  <position>
    <id>1234567</id>
    <subcompany>Acme GmbH</subcompany>
    <office>Berlin</office>
    <department>Operations</department>
    <recruitingCategory>Operations</recruitingCategory>
    <name>Operations Specialist</name>
    <jobDescriptions>
      <jobDescription><name>Your mission</name><value><![CDATA[<p>Keep operations running.</p>]]></value></jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <createdAt>2026-08-14T10:00:00+02:00</createdAt>
  </position>
  <position>
    <id>7654321</id>
    <office>London</office>
    <department>Engineering</department>
    <name>Backend Engineer</name>
    <jobDescriptions>
      <jobDescription><name>Role</name><value><![CDATA[<p>Write services.</p>]]></value></jobDescription>
    </jobDescriptions>
    <employmentType>permanent</employmentType>
    <createdAt>2026-08-01T10:00:00+02:00</createdAt>
  </position>
</workzag-jobs>`;

export const BAMBOOHR_LIST = {
  result: [
    { id: 55001, jobOpeningName: "Operations Assistant", departmentLabel: "Operations", employmentStatusLabel: "Full-Time", location: { city: "London", state: "England" }, isRemote: false, datePosted: "2026-08-26" },
    { id: 55002, jobOpeningName: "Remote Support Engineer", departmentLabel: "Support", employmentStatusLabel: "Full-Time", location: { city: "", state: "" }, isRemote: true, datePosted: "2026-08-27" },
  ],
};

export const PINPOINT_POSTINGS = {
  data: [
    { id: 771, title: "Operations Executive", url: "https://acme.pinpointhq.com/en/postings/771", created_at: "2026-08-19T09:00:00Z", location: { name: "London, UK" }, department: { name: "Operations" }, employment_type: "Permanent" },
    { id: 772, title: "Finance Analyst", url: "https://acme.pinpointhq.com/en/postings/772", created_at: "2026-08-21T09:00:00Z", location: "Remote, UK", department: "Finance" },
  ],
};

export const BREEZY_JSON = [
  { id: "b1", friendly_id: "operations-manager", name: "Operations Manager", url: "https://acme.breezy.hr/p/operations-manager", published_date: "2026-08-23T00:00:00Z", location: { name: "London, United Kingdom", city: "London", country: { name: "United Kingdom" } }, type: { name: "Full-Time" }, department: "Operations" },
];

export const WORKABLE_V3 = {
  total: 2,
  results: [
    {
      id: "w1",
      shortcode: "ABCDEF0123",
      title: "Operations Manager",
      remote: false,
      workplace: "hybrid",
      location: { country: "United Kingdom", countryCode: "GB", city: "London", region: "England" },
      department: ["Operations"],
      published_on: "2026-08-24",
      type: "Full-time",
    },
    {
      id: "w2",
      shortcode: "ABCDEF0124",
      title: "Remote Customer Success Manager",
      remote: true,
      workplace: "remote",
      location: { country: "United Kingdom", countryCode: "GB", city: "", region: "" },
      department: "Customer Success",
      published_on: "2026-08-25",
      type: "Full-time",
    },
  ],
};

/** An Anthropic-style careers landing page that links on to the real listing. */
export const LANDING_PAGE_HTML = `<!doctype html><html><head><title>Careers \\ Acme Robotics</title></head>
<body>
  <header><nav><a href="/">Home</a><a href="/research">Research</a><a href="/careers">Careers</a></nav></header>
  <main>
    <h1>Join us</h1>
    <p>We are a team of researchers and engineers.</p>
    <a href="/careers/jobs">See open roles</a>
    <a href="/careers/interview-process">Our interview process</a>
  </main>
  <footer><a href="/privacy">Privacy</a><a href="/terms">Terms</a></footer>
</body></html>`;

/** The listing that landing page points at: job links straight into a Greenhouse board. */
export const LISTING_PAGE_HTML = `<!doctype html><html><head><title>Open roles \\ Acme Robotics</title></head>
<body>
  <header><nav><a href="/">Home</a><a href="/careers">Careers</a></nav></header>
  <main>
    <h2>Operations</h2>
    <ul class="roles">
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001001">Operations Manager</a><span class="loc">London, UK</span></li>
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001002">Senior Operations Associate</a><span class="loc">Remote - USA</span></li>
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001004">Head of Business Operations</a><span class="loc">New York, NY</span></li>
    </ul>
    <h2>Engineering</h2>
    <ul class="roles">
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001003">Software Engineer, Platform</a><span class="loc">London, UK</span></li>
      <li><a href="https://job-boards.greenhouse.io/acme/jobs/4001005">Operations Intern</a><span class="loc">Manchester, UK</span></li>
    </ul>
    <a href="/careers">Back to careers</a>
  </main>
</body></html>`;

/** An Anduril-style page: a shell whose roles are fetched by JavaScript. */
export const SHELL_PAGE_HTML = `<!doctype html><html><head><title>Open Roles | Acme Industries</title></head>
<body><div id="root"></div><script src="/static/app.js"></script></body></html>`;

export const SHELL_BUNDLE_JS = `
  var CONFIG={apiBase:"https://boards-api.greenhouse.io\\/v1\\/boards\\/acmeindustries\\/jobs?content=true"};
  fetch(CONFIG.apiBase).then(function(r){return r.json()});
`;

export const RENDERED_SHELL_HTML = `<!doctype html><html><head><title>Open Roles | Acme Industries</title></head>
<body><div id="root">
  <a href="https://job-boards.greenhouse.io/acmeindustries/jobs/5001">Operations Manager</a><span>Costa Mesa, CA</span>
  <a href="https://job-boards.greenhouse.io/acmeindustries/jobs/5002">Mission Operations Lead</a><span>London, UK</span>
  <a href="https://job-boards.greenhouse.io/acmeindustries/jobs/5003">Supply Chain Operations</a><span>Costa Mesa, CA</span>
</div></body></html>`;

export const HOMEPAGE_WITH_CAREERS_LINK = `<!doctype html><html><head>
  <title>Acme Robotics | Building the future</title>
  <meta property="og:site_name" content="Acme Robotics">
  <link rel="icon" href="/favicon.png">
</head><body>
  <header><nav>
    <a href="/">Home</a><a href="/product">Product</a><a href="/research">Research</a>
    <a href="/blog">Blog</a><a href="/careers">Careers</a>
  </nav></header>
  <main><h1>Acme Robotics</h1><p>We build robots.</p></main>
  <footer><a href="/privacy">Privacy</a><a href="/careers">Join the team</a></footer>
</body></html>`;

export const HOMEPAGE_WITH_OPEN_ROLES_LINK = `<!doctype html><html><head>
  <title>Acme Industries</title>
</head><body>
  <header><nav><a href="/">Home</a><a href="/mission">Mission</a><a href="/open-roles">Open Roles</a></nav></header>
  <main><h1>Acme Industries</h1><p>Defence technology.</p></main>
</body></html>`;

export const JSONLD_LISTING_HTML = `<!doctype html><html><head><title>Careers - Acme Foods</title>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"ItemList","itemListElement":[
 {"@type":"ListItem","position":1,"item":{"@type":"JobPosting","title":"Operations Manager","url":"https://acmefoods.example.com/careers/operations-manager","datePosted":"2026-08-20","employmentType":"FULL_TIME","identifier":{"@type":"PropertyValue","name":"req","value":"REQ-1"},"description":"<p>Run the kitchen operations.</p>","jobLocation":{"@type":"Place","address":{"@type":"PostalAddress","addressLocality":"London","addressRegion":"England","addressCountry":"GB"}},"baseSalary":{"@type":"MonetaryAmount","currency":"GBP","value":{"@type":"QuantitativeValue","minValue":60000,"maxValue":75000,"unitText":"YEAR"}}}},
 {"@type":"ListItem","position":2,"item":{"@type":"JobPosting","title":"Remote Operations Analyst","url":"https://acmefoods.example.com/careers/remote-operations-analyst","datePosted":"2026-08-22","jobLocationType":"TELECOMMUTE","description":"Analyse operations.","jobLocation":{"@type":"Place","address":{"addressCountry":"GB"}}}},
 {"@type":"ListItem","position":3,"item":{"@type":"JobPosting","title":"Chef de Partie","url":"https://acmefoods.example.com/careers/chef-de-partie","datePosted":"2026-08-10","jobLocation":{"@type":"Place","address":{"addressLocality":"Manchester","addressCountry":"GB"}}}},
 {"@type":"ListItem","position":4,"item":{"@type":"JobPosting","title":"Head of Supply Operations","url":"https://acmefoods.example.com/careers/head-of-supply-operations","datePosted":"2026-08-15","jobLocation":[{"@type":"Place","address":{"addressLocality":"London","addressCountry":"GB"}},{"@type":"Place","address":{"addressLocality":"Dublin","addressCountry":"IE"}}]}}
]}
</script></head><body><h1>Careers</h1></body></html>`;

export const EMBEDDED_GREENHOUSE_HTML = `<!doctype html><html><head><title>Careers | Acme Robotics</title></head>
<body>
  <div id="grnhse_app"></div>
  <script src="https://boards.greenhouse.io/embed/job_board/js?for=acme"></script>
  <script>
    window.__DATA__ = {"boardToken":"acme","endpoint":"https://boards-api.greenhouse.io\\/v1\\/boards\\/acme\\/jobs"};
  </script>
</body></html>`;

// --- Tier-2 boards. VERIFY: shapes modelled on observed public sites, not vendor docs. ---

export const EIGHTFOLD_PAGE = {
  count: 2,
  positions: [
    { id: 563100001, name: "Head of Operations, EMEA", location: "London, United Kingdom", locations: ["London, United Kingdom", "Dublin, Ireland"], department: "Operations", canonicalPositionUrl: "https://careers.acme.example/careers/job/563100001", t_create: 1757000000, job_description: "<p>Run EMEA operations.</p>" },
    { id: 563100002, name: "Staff Engineer", location: "Remote - US", department: "Engineering", canonicalPositionUrl: "https://careers.acme.example/careers/job/563100002", t_create: 1757100000 },
  ],
};

export const RIPPLING_BOARD = {
  items: [
    { id: "rp-1", name: "Director of Finance", url: "https://ats.rippling.com/acme/jobs/rp-1", workLocation: { label: "London, UK" }, department: { label: "Finance" }, employmentType: { label: "Full-time" }, publishedAt: "2026-09-01T09:00:00Z" },
    { id: "rp-2", name: "Support Specialist", url: "https://ats.rippling.com/acme/jobs/rp-2", workLocation: { label: "Remote (Global)" }, department: { label: "Support" } },
  ],
};

export const TEAMTAILOR_PAGE_1 = `<!doctype html><html><body data-controller="teamtailor">
<ul id="jobs_list_container">
<li><a href="/jobs/4410001-operations-manager"><span class="text-block-base-link">Operations Manager</span><div class="mt-1 text-md">Operations · London</div></a></li>
<li><a href="/jobs/4410002-vp-strategy"><span class="text-block-base-link">VP Strategy</span><div class="mt-1 text-md">Leadership · Remote</div></a></li>
</ul><a href="/jobs?page=2">Next</a></body></html>`;
export const TEAMTAILOR_PAGE_2 = `<!doctype html><html><body data-controller="teamtailor">
<ul id="jobs_list_container">
<li><a href="/jobs/4410003-finance-lead"><span class="text-block-base-link">Finance Lead</span><div class="mt-1 text-md">Finance · Stockholm</div></a></li>
</ul></body></html>`;
export const TEAMTAILOR_PAGE_3 = `<!doctype html><html><body data-controller="teamtailor"><ul id="jobs_list_container"></ul></body></html>`;

export const ICIMS_PAGE_0 = `<!doctype html><html><body><div class="iCIMS_JobsTable">
<div class="row"><a href="https://careers-acme.icims.com/jobs/9001/head-of-operations/job?in_iframe=1"><h3>Head of Operations</h3></a><span class="header left"><span>UK-London</span></span><dl><dt>Posted Date</dt><dd>2026-09-02</dd></dl></div>
<div class="row"><a href="https://careers-acme.icims.com/jobs/9002/nurse/job"><h3>Nurse</h3></a><span class="header left"><span>US-CA-Los Angeles</span></span></div>
</div></body></html>`;
export const ICIMS_PAGE_1 = `<!doctype html><html><body><div class="iCIMS_JobsTable"></div></body></html>`;

export const SUCCESSFACTORS_PAGE_0 = `<!doctype html><html><body><span class="paginationLabel">Results 1 – 25 of 26</span><table>
<tr><td><a class="jobTitle-link" href="/job/London-Director-of-Operations-SW1/1234567/">Director of Operations</a></td><td><span class="jobLocation">London, GB</span></td><td><span class="jobDate">Sep 3, 2026</span></td></tr>
<tr><td><a class="jobTitle-link" href="/job/Munich-Engineer/1234568/">Engineer</a></td><td><span class="jobLocation">Munich, DE</span></td><td><span class="jobDate">Sep 1, 2026</span></td></tr>
</table></body></html>`;
export const SUCCESSFACTORS_PAGE_25 = `<!doctype html><html><body><span class="paginationLabel">Results 26 – 26 of 26</span><table>
<tr><td><a class="jobTitle-link" href="/job/Paris-Chief-of-Staff/1234569/">Chief of Staff</a></td><td><span class="jobLocation">Paris, FR</span></td><td><span class="jobDate">Aug 30, 2026</span></td></tr>
</table></body></html>`;
export const SUCCESSFACTORS_PAGE_50 = `<!doctype html><html><body><span class="paginationLabel">Results 51 – 50 of 26</span><table></table></body></html>`;

export const JOBVITE_PAGE = `<!doctype html><html><body><div class="jv-wrapper">
<h3 class="jv-job-list-category">Operations</h3>
<table class="jv-job-list"><tr><td class="jv-job-list-name"><a href="/acme/job/oXYZabc">Head of Operations</a></td><td class="jv-job-list-location">London, United Kingdom</td></tr></table>
<h3 class="jv-job-list-category">Engineering</h3>
<table class="jv-job-list"><tr><td class="jv-job-list-name"><a href="/acme/job/oDEF123">Backend Engineer</a></td><td class="jv-job-list-location">Remote, US</td></tr></table>
</div></body></html>`;

export const JAZZHR_PAGE = `<!doctype html><html><body><ul class="list-group">
<li class="list-group-item"><a href="https://acme.applytojob.com/apply/AbC123xyz/Operations-Director">Operations Director</a><ul class="list-inline"><li>London, UK</li><li>Operations</li><li>Full Time</li></ul></li>
<li class="list-group-item"><a href="https://acme.applytojob.com/apply/DeF456uvw/Warehouse-Associate">Warehouse Associate</a><ul class="list-inline"><li>Austin, TX</li><li>Logistics</li></ul></li>
</ul></body></html>`;
