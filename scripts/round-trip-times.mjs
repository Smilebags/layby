const FIVE_MINUTES = 5 * 60 * 1000;

const input = await new Response(process.stdin).text();
const document = JSON.parse(input);
const trips = Array.isArray(document) ? document : document.trips;
if (!Array.isArray(trips)) throw new Error("The file has no trip list.");

for (const trip of trips) {
  trip.startedAt = Math.floor(trip.startedAt / FIVE_MINUTES) * FIVE_MINUTES;
  trip.endedAt = Math.ceil(trip.endedAt / FIVE_MINUTES) * FIVE_MINUTES;
  delete trip.distanceM;
  delete trip.startAddress;
  delete trip.endAddress;
  delete trip.startPostcode;
  delete trip.endPostcode;
}

process.stdout.write(`${JSON.stringify(document, null, 2)}\n`);
