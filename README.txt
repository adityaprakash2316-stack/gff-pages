TWO PAGES: Her page + Your private photo page
=============================================

HER PAGE   -> http://localhost:3000/        (you send her the public link)
YOUR PAGE  -> http://localhost:3000/admin   (password protected, only you)

Photos she sends are saved in the "uploads" folder on your computer
and shown on your admin page.

STEP 1 - Install Node.js (one time)
  Download the LTS version from https://nodejs.org and install it.

STEP 2 - Start the server
  Open this folder in a terminal (Windows: type "cmd" in the folder's address bar) and run:

      node server.js MySecretPass123

  (Use your own password, at least 6 characters.)

STEP 3 - Make a link she can open from her phone
  Open a second terminal and run:

      winget install Cloudflare.cloudflared
      cloudflared tunnel --url http://localhost:3000

  It prints a link like  https://something-random.trycloudflare.com
  -> Send THAT link to her.
  -> Your page is that link + /admin   (or http://localhost:3000/admin)

IMPORTANT
  - Keep both terminal windows open while she uses it. Your PC must stay on.
  - The tunnel link changes every time you restart it.
  - Use a strong password. After 5 wrong tries the login locks for 10 minutes.
  - Only send the link to your girlfriend, and keep her photos private.
