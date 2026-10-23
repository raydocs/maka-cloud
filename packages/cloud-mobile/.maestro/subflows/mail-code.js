// Reads the sign-in code the test server "mailed" to EMAIL, from its control port (CONTROL).
const response = http.post(CONTROL, {
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ op: 'mail-code', address: EMAIL }),
});
output.code = json(response.body).code;
