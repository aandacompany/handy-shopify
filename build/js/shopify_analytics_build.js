(()=>{
  'use strict';
  let globalObject = {};
  globalObject.charts = {};
  window.addEventListener('load', initialize);

  function initialize() {
    // set event listener on submit button
    setEventListeners();

    // set max dates on start and end date input elements
    setMaxDates();
  }


  function setEventListeners() {
    // set event listener on submit button
    const submitButton = document.getElementById('submit');
    if(submitButton){
      submitButton.addEventListener('click', handleFormSubmit);
    }

    // set event listener on the start date button
    const start = document.getElementById('start');
    start.addEventListener('change', setMinDates);
  }

  function handleFormSubmit(e) {
    e.preventDefault();
    // get the start and end dates
    const start = document.getElementById('start').value;
    const end = document.getElementById('end').value;
    if(start === globalObject.start && end === globalObject.end){
      
    } else {
      setAlert({type: 'info', msg: 'running query.  please wait...'});
      sendRequest({start, end})
      .then(()=> refreshCharts())
      .then(()=>{
        globalObject.start = start;
        globalObject.end = end;        
      });
    }
  }

  function setAlert({type='info', msg}) {
    // identify alert location
    const alert = document.getElementsByClassName('alert');

    // decide alert class
    let alertClass;
    switch(type){
      case 'info':
        alertClass = 'alert-info';
        break;
      case 'warning':
        alertClass = 'alert-warning';
        break;
    }

    for(let i=0; i<alert.length; i++){
      alert[i].classList.add(alertClass);
      alert[i].innerText = msg;
    }
  }

  function setMaxDates() {
    // set the max attribute for both start and end dates to today
    const start = document.getElementById('start');
    const end = document.getElementById('end');

    const now = new Date();
    const year = now.getFullYear();
    const month = padToTwoDigits(now.getMonth()+1);
    const date = padToTwoDigits(now.getDate());
    const max = year + '-' + month + '-' + date;
    start.max = max;
    end.max = max;
  }

  function setMinDates() {
    // set the min attribute of the end date picker
    const startValue = document.getElementById('start').value;
    const end = document.getElementById('end').min = startValue;
  }

  function padToTwoDigits(int) {
    // convert a single digit integer to 2 digits eg 2 -> 02
    int = int.toString(10);
    if(int.length < 2){
      int = '0' + int;
    }

    return int;
  }

  function sendRequest({start, end}) {
    return new Promise((resolve, reject)=>{
      const destination = '/handy/shopify_analytics';
      const method = 'GET';
      const query = '?start=' + encodeURIComponent(start) + '&end=' + encodeURIComponent(end);
      const request = new XMLHttpRequest();
      request.open(method, destination + query, true);
      request.send();
      request.onreadystatechange = ()=>{
        if(request.readyState === XMLHttpRequest.DONE){
          try{
            let response = JSON.parse(request.responseText);
            if(response.error){
              return reject(new Error(response.error));
            } else {
              globalObject.data = response.data;
              return resolve()
            }
          }
          catch(err){
            return reject(new Error('error getting report from backend - ' + err.message));
          }
        }
      }
    })
  }

  function refreshCharts() {
    // redraw charts
    return new Promise((resolve, reject)=>{
      const charts = ['customer_count', 'customer_adds', 'customer_losses', 'plan_changes'];
      const stats = ['mrr', 'customer_adds', 'customer_losses'];  // charts with stats columns
      const response_data = globalObject.data; // {chart1: {date1: {line1: val1}}}
      const backgroundColor = 'hsl(0,0%,99%)';

      charts.forEach((chart)=>{
        // customer_count data object contains both customer_count and mrr so need to split it out
        const subCharts = chart === 'customer_count' ? ['mrr', 'customer_count'] : [chart];
        subCharts.forEach((subChart)=>{

          let statOutput = '';
          const context = document.getElementById(subChart).getContext('2d');
          const options = {
            title: {
              display: false,
              text: subChart
            },
            scales: {
              yAxes: [{
                ticks: {
                  stepSize: 1,
                  suggestedMin: 0,
                }
              }]
            },

          }

          let data = {
            labels: Object.keys(response_data[chart]), // ['12/1/19', '12/2/19', ..]
            datasets: [],
          };

          let datasetArray = [];
          data.labels.forEach((label)=>{
            let lineObject;
            switch(subChart){
              case 'customer_count':
              case 'mrr':
                lineObject = response_data[chart][label][subChart];
                break;
              default:
                lineObject = response_data[subChart][label];
                break;
            }

            Object.keys(lineObject).forEach((line)=>{
              if(!datasetArray.includes(line)){datasetArray.push(line)}
            })
          })

          const numberOfDatasets = datasetArray.length;

          let chartStats = {};
          if(stats.includes(subChart)){
            datasetArray.forEach((line)=>{
              chartStats[line] = {
                sum: 0,
                count: 0,
                avg: null,
                max: 0
              }
            })
          }

          datasetArray.forEach((datasetSegment, index)=>{
            let datasetSlug = {
              lineTension: 0,
              label: datasetSegment,
              borderColor: selectColor(index, numberOfDatasets),
              backgroundColor: backgroundColor,
              data: [],
            }

            data.labels.forEach((label)=>{
              let dataContainer;

              switch(subChart){
                case 'customer_count':
                case 'mrr':
                  dataContainer = response_data[chart][label][subChart];
                  break;
                default:
                  dataContainer = response_data[chart][label];
                  break;
              }
              datasetSlug.data.push(dataContainer[datasetSegment]);

              // calculate stats
              if(chartStats[datasetSegment]){
                chartStats[datasetSegment].sum += dataContainer[datasetSegment] || 0;
                chartStats[datasetSegment].count++;
                chartStats[datasetSegment].max = Math.max(chartStats[datasetSegment].max, dataContainer[datasetSegment] || 0);
              }
            })

            data.datasets.push(datasetSlug);
          })

          // destroy any existing charts before creating new ones
          if(globalObject.charts[subChart]){globalObject.charts[subChart].destroy(); }
          globalObject.charts[subChart] = new Chart(context, {
            type: 'line',
            data: data,
            options: options
          })

          // add stats
          if(stats.includes(subChart)){
            // calculate averages for each line
            Object.keys(chartStats).forEach((line)=>{
              chartStats[line].avg = Math.round(chartStats[line].sum / chartStats[line].count);
              statOutput += `
                <div class="d-inline-block pr-5 pl-3">
                <p class="font-weight-bold" >${line}</p>
                <p>Average: ${chartStats[line].avg} </p>
                <p>Maximum: ${chartStats[line].max} </p>
                </div>
              `
            })
          }

          // insert into the chart
          const chartInsertPoint = document.getElementById(subChart + '_stats')
          if(chartInsertPoint){
            chartInsertPoint.innerHTML = statOutput;
          }


        })
      })

      return resolve();
    })
  }

  function selectColor(colorNum, colors){
      if (colors < 1) colors = 1; // defaults to one color - avoid divide by zero
      return "hsl(" + (colorNum * (360 / colors) % 360) + ",100%,50%)";
  }

})();