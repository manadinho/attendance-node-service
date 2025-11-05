const cron = require('node-cron');
const { getRedis } = require('../redisClient');
const { sendText, getStatus } = require('../whatsapp'); // use exported API
const { timeStrToSeconds, localSecondsSinceMidnight, prettyTime, prepareAttendanceMessage } = require('../utils');
require('dotenv').config();

let redis;
let ATTENDANCE_CRON_STATUS = 'stopped';

const inWindow = (sec, start, end) => sec >= start && sec <= end;

/** Starts the attendance processing cron */
async function startAttendanceCron() {
  if(ATTENDANCE_CRON_STATUS === 'running') {
	console.log('⚠️ Attendance cron is already running');
	return;
  }
  ATTENDANCE_CRON_STATUS = 'running';

  if (!redis) redis = await getRedis();

  cron.schedule('* * * * *', async () => {
    console.log('⏰ Running a job every 1 minute to process attendances');

    try {
			const alreadySent = [];
      // Skip if WA disconnected (optional guard)
      if (getStatus().status !== 'connected') {
        console.log('⚠️ Skipping: WhatsApp is not connected');
        return;
      }

      let attendance;
      while ((attendance = await redis.lPop('attendances'))) {
				const attendanceObj = JSON.parse(attendance);
        console.log('📤 Processing attendance:', attendanceObj);
				if(alreadySent.includes(attendanceObj.rfid)) {
					continue;
				}

				alreadySent.push(attendanceObj.rfid);

				const student = await redis.hGet('students', String(attendanceObj.rfid));
				const school = await redis.hGet('schools', String(attendanceObj.channelId));
				const schoolMessageTemplates = await redis.hGet('attendance_message_templates', String(attendanceObj.channelId));
				if(!student || !school) {
					console.log('❌ Skipping Attendance: Student or school not found', attendanceObj);
					continue;
				}

				const studentObj = JSON.parse(student);
				const schoolObj = JSON.parse(school);
				const schoolMessageTemplatesObj = JSON.parse(schoolMessageTemplates);

				const ciStart = timeStrToSeconds(schoolObj.checkin_start) - (schoolObj?.buffer_minutes * 60);
				const ciEnd   = timeStrToSeconds(schoolObj.checkin_end) + (schoolObj?.buffer_minutes * 60);
				const coStart = timeStrToSeconds(schoolObj.checkout_start) - (schoolObj?.buffer_minutes * 60);
				const coEnd   = timeStrToSeconds(schoolObj.checkout_end) + (schoolObj?.buffer_minutes * 60);

				const secFromMidnight = localSecondsSinceMidnight(Number(attendanceObj?.timestamp));

				let kind = 'outside';
				if (inWindow(secFromMidnight, ciStart, ciEnd)) kind = 'checkin';
				else if (inWindow(secFromMidnight, coStart, coEnd)) kind = 'checkout';

				// Build message
				const at = prettyTime(Number(attendanceObj?.timestamp));

				let text;
				if (kind == 'checkin') {
					const messageTemplate = schoolMessageTemplatesObj?.find(template => template.type == 'arrival')?.body || '✅ Dear {guardian_name}. {student_name} checked in at {date_time}.';
					text = prepareAttendanceMessage(
							{
								template: messageTemplate, 
								studentName: studentObj.name, 
								guardianName: studentObj.guardian_name, 
								time: at, 
								standard_name: studentObj.standard_name,
								schoolName: schoolObj.name
							});
				} else if (kind == 'checkout') {
					const messageTemplate = schoolMessageTemplatesObj?.find(template => template.type == 'departure')?.body || '🏁 Dear {guardian_name}. {student_name} checked out at {date_time}.';
					text = prepareAttendanceMessage(
						{
							template: messageTemplate, 
							studentName: studentObj.name, 
							guardianName: studentObj.guardian_name, 
							time: at, 
							standard_name: studentObj.standard_name,
							schoolName: schoolObj.name
						});
				}

				if(!text) {
					console.log('❌ Skipping Attendance: Not in check-in or check-out window', attendanceObj, secFromMidnight, ciStart, ciEnd, coStart, coEnd);
					continue;
				}

        await sendText(studentObj.guardian_contact, text);
      }

	  ATTENDANCE_CRON_STATUS = 'stopped';
      console.log('✅ Finished processing attendances');
    } catch (err) {
      console.error('❌ Error processing attendances:', err);
    }
  });
}

module.exports = { startAttendanceCron };
