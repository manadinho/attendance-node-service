const cron = require('node-cron');
const { getRedis } = require('../redisClient');
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
		const channelMessages = {};
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
					const channelKey = String(attendanceObj.channelId);
					if (!channelMessages[channelKey]) {
						const whatsappUrl = schoolObj?.whatsapp_url+'/skl-'+schoolObj.id+"/send-attendance-messages" || '';
						channelMessages[channelKey] = { whatsappUrl, messages: [] };
					}
					channelMessages[channelKey].messages.push({
						phoneNumber: studentObj.guardian_contact,
						message: text
					});

			// await sendText(studentObj.guardian_contact, text);
		}

	  	for (const [channelId, payload] of Object.entries(channelMessages)) {
			const { whatsappUrl, messages } = payload || {};
			if (!whatsappUrl || !messages?.length) {
				console.log(`⚠️ Skipping channel ${channelId}: Missing WhatsApp URL or messages`);
				continue;
			}


			try {
				const res = await fetch(whatsappUrl, {
					method: 'POST',
					headers: { 'Content-Type': 'application/json', 'x-den-api-key': process.env.DEN_API_KEY || '' },
					body: JSON.stringify({messages: messages}),
				});

				if (!res.ok) {
					console.error(`❌ Failed to notify channel ${channelId} via ${whatsappUrl}:`, res.status, res.statusText);
				} else {
					console.log(`📨 Sent ${messages.length} messages to channel ${channelId}`);
				}
			} catch (error) {
				console.error(`❌ Error calling ${whatsappUrl} for channel ${channelId}:`, error.message);
			}
		}
	  ATTENDANCE_CRON_STATUS = 'stopped';
      console.log('✅ Finished processing attendances');
    } catch (err) {
      console.error('❌ Error processing attendances:', err);
    }
  });
}

module.exports = { startAttendanceCron };
