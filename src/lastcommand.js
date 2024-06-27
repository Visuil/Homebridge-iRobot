const dorita980 = require('dorita980');

if (!process.argv[4]) {
  console.log('Usage: npm run getlastcommand <robot_blid> <robot_pwd> <robot_ip_address>');
  process.exit();
}

const robot_blid = process.argv[2];
const robot_pwd = process.argv[3];
const robot_ip_address = process.argv[4];

const iRobot = new dorita980.Local(robot_blid, robot_pwd, robot_ip_address);

iRobot.on('connect', init);

function init() {
  iRobot.getRobotState(['lastCommand'])
    .then(result => {
      console.log("lastCommand:", result.lastCommand, ", regionsDetails:", result.lastCommand.regions);
      iRobot.end();
    })
    .catch(console.log);
}
