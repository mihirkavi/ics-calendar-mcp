import comprehensive from "./comprehensive.ics?raw";
import dst from "./dst.ics?raw";
import malformed from "./malformed.ics?raw";

export { comprehensive, dst, malformed };

export const SECRET_MARKERS = [
  "SECRET-",
  "secret-organizer",
  "secret-attendee",
  "Room-42",
  "Synthetic Fixture Calendar",
  "BEGIN:VEVENT",
  "fixture.test",
];
