import dorita980 from 'dorita980';

if (process.argv.length < 5) {
  console.log('Usage: npm run getlastcommand <robot_blid> <robot_pwd> <robot_ip_address>');
  process.exit();
}

const robot_blid: string = process.argv[2];
const robot_pwd: string = process.argv[3];
const robot_ip_address: string = process.argv[4];

const IRobot = new dorita980.Local(robot_blid, robot_pwd, robot_ip_address);

IRobot.on('connect', init);

function init(): void {
  IRobot.getRobotState(['lastCommand'])
	.then((result: { lastCommand: { regions: any } }) => {
	  console.log('lastCommand:', result.lastCommand, ', regionsDetails:', result.lastCommand.regions);
	  IRobot.end();
	})
	.catch(console.log);
}