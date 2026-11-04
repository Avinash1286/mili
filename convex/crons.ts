import { cronJobs, makeFunctionReference } from 'convex/server';
const crons = cronJobs();
crons.hourly('expire retained lessons and remove private orphan files', { minuteUTC: 37 }, makeFunctionReference<'mutation'>('maintenance:sweep'), {});
crons.interval('recover restored or interrupted outbox jobs', { minutes: 1 }, makeFunctionReference<'mutation'>('recovery:sweep'), {});
export default crons;
