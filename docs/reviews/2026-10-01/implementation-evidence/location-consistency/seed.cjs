/** Reset only the dedicated local browser database, then add synthetic resolved roles. */
const { execFileSync } = require('node:child_process');
const { Client } = require('/Users/h_dryden/Documents/New project/christopher-jtbd-review/node_modules/.pnpm/pg@8.23.0/node_modules/pg');
const path = require('node:path');

const evidence = path.resolve(__dirname, '../workday-region/workday-multi-location-detail.json');
const detail = require(evidence).jobPostingInfo;
const locations = [detail.location, ...detail.additionalLocations];
if (locations.length !== 70 || !locations.includes('USA, MA, Boston')) throw new Error('Workday location evidence changed');

(async () => {
  execFileSync('node', [path.resolve(__dirname, '../workday-location-web/seed.cjs')]);
  const client = new Client({ connectionString: 'postgres://postgres:postgres@127.0.0.1:55439/ava_locations_web' });
  await client.connect();
  try {
    const { rows: [owner] } = await client.query('select id from users where email=$1', ['location-browser@example.com']);
    const { rows: [source] } = await client.query("select id,company_id from career_sources where type='workday' limit 1");
    const roles = [
      { key: 'resolved-70', title: 'Payroll consultant — 70 locations', location: locations[0], locations },
      { key: 'resolved-2', title: 'Operations consultant — two locations', location: 'London', locations: ['London', 'Manchester'] },
      { key: 'long-location', title: 'Location wrapping fixture', location: 'Bristol',
        locations: ['Bristol', 'Bath', 'Cardiff', `Synthetic ${'A'.repeat(180)}`] },
    ];
    for (const role of roles) {
      const { rows: [job] } = await client.query(
        `insert into jobs(company_id,source_id,external_key,title,normalized_title,url,location,locations,location_resolution,location_label)
         values($1,$2,$3,$4,$5,$6,$7,$8::jsonb,'resolved',$9) returning id`,
        [source.company_id, source.id, role.key, role.title, role.title.toLowerCase(), `https://fixture.wd1.myworkdayjobs.com/External/job/${role.key}`, role.location, JSON.stringify(role.locations), `${role.locations.length} Locations`],
      );
      await client.query('insert into user_jobs(user_id,job_id,keyword_matched,location_ok,in_table) values($1,$2,true,true,true)', [owner.id, job.id]);
    }
    console.log(JSON.stringify({ fixture: 'synthetic offline roles in ava_locations_web', roleCount: roles.length, locationCounts: roles.map(role => role.locations.length) }));
  } finally {
    await client.end();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
