(()=>{
  window.addEventListener('load', initialize);

  let globalObject = {};

  function initialize() {
    globalObject.app_settings = loadSavedSettings('app_settings');
    globalObject.plan_name = loadSavedSettings('plan_name').plan_name;

    // check if browser allows setting cookies in iframe (necessary to send session data to backend)
    let cookieCheck = checkCookieSettings();  // true if cookies can be set

    // if cookie check is false, display request to authorize setting cookies
    hideCookieAuthorizationNotice(cookieCheck);

    // set event listeners on plan selection
    let planSelectors = document.getElementsByClassName('plan_selector');
    for(let i=0; i<planSelectors.length; i++){
      planSelectors[i].addEventListener('click', handlePlanSelection);
    }
  }

  // load settings passed from backend
  function loadSavedSettings(key) {
    let settings = document.getElementById(key).innerHTML;

    try {
      settings = JSON.parse(settings);
    } catch (err) {
      settings = {};
    }

    return settings;
  }

  async function handlePlanSelection(e) {
    e.preventDefault();
    const session_token = await getSessionToken(app);
    let redirect = Redirect.create(app);
    let toastOptions = {duration: 5000};
    let toastErrorOptions = {duration: 5000, isError: true};
    const loading = Loading.create(app);
    loading.dispatch(Loading.Action.START);
    const planSelected = e.target.dataset.planName;
    const origin = window.location.origin;
    const search = window.location.search;

    // check if selected and current plan are the same
    if(planSelected === globalObject.plan_name){

      // redirect to admin page
      let redirect = Redirect.create(app);
      redirect.dispatch(Redirect.Action.APP, '/');

      toastOptions.message = 'Selected plan is the same as currently subscribed.  Please wait to be redirected to the admin page';
      const toastNotice = Toast.create(app, toastOptions);
      toastNotice.dispatch(Toast.Action.SHOW);
    
    } else {

      // post plan choice to backend
      const plan_settings = {
        plan: planSelected,
        _csrf: document.getElementById('_csrf').value // add csrf token

      };
      let payload = [];
      Object.keys(plan_settings).forEach(function (key) {
        payload.push(key + '=' + plan_settings[key]);
      });
      payload = payload.join('&');
      let request = new XMLHttpRequest();
      const destination = '/handy/shopify/admin/plan';
      const method = 'POST';
      request.open(method, destination, true);
      request.setRequestHeader('Content-Type', 'application/x-www-form-urlencoded');
      request.setRequestHeader('session-token', session_token);
      request.send(payload);
      toastOptions.message = 'Changing plan selection. Please wait...';
      const toastNotice = Toast.create(app, toastOptions);
      toastNotice.dispatch(Toast.Action.SHOW);

      let response;

      request.onreadystatechange =  ()=>{
        if (request.readyState === XMLHttpRequest.DONE) {
          if (request.status === 200) {
            // if redirect to redirect_url if supplied else redirect to admin page
            try{
              response = JSON.parse(request.responseText);
            }
            catch(err){
              response.redirect_url = null;
              toastErrorOptions = err.message;
              const toastError = Toast.create(app, toastErrorOptions);
              toastError.dispatch(Toast.Action.SHOW);
              loading.dispatch(Loading.Action.STOP);
            }

            const {redirect_url} = response;
            let redirect = Redirect.create(app);
            if(redirect_url){
              // redirect to redirect_url
              redirect.dispatch(Redirect.Action.REMOTE, redirect_url);
            } else {
              // redirect to admin page
              redirect.dispatch(Redirect.Action.APP, '/');
            }

            loading.dispatch(Loading.Action.STOP);
          } else {
            try {
              response = JSON.parse(request.responseText);
            } catch (err) {
              response = {err};
            }

            let responseError = response.err;

            if (responseError) {
              // send alert
              toastErrorOptions.message = responseError;
              const toastError = Toast.create(app, toastErrorOptions);
              toastError.dispatch(Toast.Action.SHOW);
              loading.dispatch(Loading.Action.STOP);
            }
          }
        }
      }
    }
  }

  /* 
   * Safari prevents the site from setting cookies when displayed in an iframe
   * thus preventing sessions from being set correctly
   * the workaround takes advantage of the fact that Safari will let the site
   * set cookies in an iframe IF the user first visits the site outside the iframe
   * so this code prompts the user to take an action that opens the site outside the
   * iframe and then closes it
   */
   function checkCookieSettings(){
      // attempt to write a test cookie
      let testCookie = 'streamthing_test_cookie=test';
      const testCookieSettings = '; SameSite=None; Secure';
      document.cookie = `${testCookie}${testCookieSettings}`;
      let testCookie_legacy = 'streamthing_test_cookie_legacy=test';  // legacy is for browsers that do not handle SameSite correctly ie Safari
      document.cookie = testCookie_legacy;

      // check if the cookie was written
      const readCookie = document.cookie;
      let cookieCheck = false;
      if((readCookie.indexOf(testCookie) > -1) || (readCookie.indexOf(testCookie_legacy) > -1)){
        cookieCheck = true;
      }

      // remove test cookie
      testCookie = `streamthing_test_cookie=; expires=${new Date().toString()} SameSite=None; Secure`;
      document.cookie = testCookie;
      testCookie_legacy = `streamthing_test_cookie_legacy=; expires=${new Date().toString()}`;
      document.cookie = testCookie_legacy;

      // return cookieCheck result
      return cookieCheck;
   }

   // display or hide message requesting authorization to set cookies
   function hideCookieAuthorizationNotice(flag){
    // show cookie authorization notice
    const cookieAuth = document.getElementById('cookie-authorization');
    if(cookieAuth && !flag){
      cookieAuth.classList.remove('hidden');
    } else {
      const billingContent = document.getElementById('billing-content');
      if(billingContent){
        billingContent.classList.remove('hidden');
      }
    }
    
    // add event listener to button
    const protocol = window.location.protocol;
    const host = window.location.host;
    const destination = protocol + '//' + host;
    const cookieAllowButton = document.getElementById('allow_cookie');
    if(cookieAllowButton){
      cookieAllowButton.addEventListener('click', addCookie.bind(null, destination));
    }
    
   }

  function addCookie(destination, e){
    e.preventDefault();
    // open new window pointing to the backend server
    const height = 10;
    const width = 10;
    const top = screen.height - height;
    const left = 0;
    let cookieSetWindow = window.open(destination, 'testwindow', 'height=' + height + ',width=' + width + ',top=' + top + ',left=' + left);

    if(!cookieSetWindow){
    }

    // open window and then close it as soon as it loads
    cookieSetWindow.addEventListener('load', ()=>{
      cookieSetWindow.close();

      // reload iframe
      window.location = document.URL;
    });
  }

})()