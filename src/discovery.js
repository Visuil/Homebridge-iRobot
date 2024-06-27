const dorita980 = require('dorita980');

// Variable to store the discovery data
let discoveryData;

// Perform discovery
dorita980.discovery((ierr, data) => {
  if (ierr) {
	// Log any errors that occur during discovery
	console.error(ierr);
  } else {
	// Assign the discovered data to the variable
	discoveryData = data;
	// Log the discovery data to the console
	console.log(discoveryData);
  }
});