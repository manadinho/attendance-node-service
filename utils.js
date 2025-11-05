function timeStrToSeconds(time) {
	const [h, m, s] = String(time || '00:00:00').split(':').map(Number);
  return (h || 0) * 3600 + (m || 0) * 60 + (s || 0);
}

function localSecondsSinceMidnight(epochSeconds, timeZone = 'UTC') {
  const d = new Date(Number(epochSeconds) * 1000);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone, hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit'
  }).formatToParts(d);
  const obj = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return (+obj.hour || 0) * 3600 + (+obj.minute || 0) * 60 + (+obj.second || 0);
}

function prettyTime(epochSeconds, timeZone = 'UTC') {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit', hour12: true })
            .format(new Date(Number(epochSeconds) * 1000));
}

function prepareAttendanceMessage(data) {
  return data?.template
    .replace('{student_name}', data?.studentName)
    .replace('{father_name}', data?.guardianName)
    .replace('{date_time}', data?.time)
    .replace('{class_name}', data?.standard_name)
    .replace('{school_name}', data?.schoolName) || '';
}

module.exports = { timeStrToSeconds, localSecondsSinceMidnight, prettyTime, prepareAttendanceMessage }