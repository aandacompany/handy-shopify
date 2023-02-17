'use strict';

const gulp = require('gulp')
, babelify = require('babelify')
, browserify = require('browserify')
, source = require('vinyl-source-stream')
, buffer = require('vinyl-buffer')
, uglify = require('gulp-uglify')
, streamify = require('gulp-streamify')
, concat = require('gulp-concat')
, cleanCSS = require('gulp-clean-css')
;


// make shopify_billing.js browser compatible
gulp.task('build-shopify_billing', ()=>{
  return browserify({
    entries: './build/js/shopify_billing_build.js',
    debug: true
  })
  .transform(babelify.configure({
      presets: [
        ["@babel/preset-env", {
            "targets": {
              "browsers": ["last 2 versions"]
            },
            useBuiltIns: 'entry',
            corejs: 3
          }
        ]
      ],
      plugins: [
        ["@babel/plugin-transform-runtime", {
              "regenerator": true
            }
        ]
      ]
    })
  )
  .bundle()
  .pipe(source('shopify_billing.min.js'))
  .pipe(buffer())
  .pipe(uglify())
  .pipe(gulp.src(['./build/js/jquery.min.js', './build/js/bootstrap.bundle.min.js'], {sourcemaps: true}))
  .pipe(concat('shopify_billing.min.js'))
  .pipe(gulp.dest('./public/js'))
})


// make shopify_billing.js browser compatible
gulp.task('build-shopify_analytics', ()=>{
  return browserify({
    entries: './build/js/shopify_analytics_build.js',
    debug: true
  })
  .transform(babelify.configure({
      presets: [
        ["@babel/preset-env", {
            "targets": {
              "browsers": ["last 2 versions"]
            },
            useBuiltIns: 'entry',
            corejs: 3
          }
        ]
      ],
      plugins: [
        ["@babel/plugin-transform-runtime", {
              "regenerator": true
            }
        ]
      ]
    })
  )
  .bundle()
  .pipe(source('shopify_analytics.min.js'))
  .pipe(buffer())
  .pipe(uglify())
  .pipe(gulp.dest('./public/js'))
})


// shopify billing screen styles
gulp.task('build-shopify_billing_styles', ()=>{
  return gulp.src(['./build/css/bootstrap.min.css', './build/css/shopify_billing_build.css'])
  .pipe(concat('shopify_billing.min.css'))
  .pipe(cleanCSS({compatibility: '*'}))
  .pipe(gulp.dest('./public/css'))
})

// shopify admin styles
gulp.task('build-shopify_admin_styles', ()=>{
  return gulp.src(['./build/css/uptown.css', './build/css/shopify_admin_build.css'])
  .pipe(concat('shopify_admin.min.css'))
  .pipe(cleanCSS({compatibility: '*'}))
  .pipe(gulp.dest('./public/css'))
})

// shopify app-bridge
gulp.task('copy-app-bridge', function() {
  return gulp.src([
    './build/js/app-bridge.min.js',
    './build/js/app-bridge-utils.min.js'
  ])
    .pipe(gulp.dest('./public/js'))
});

// set watch tasks
gulp.task('watch', ()=>{
  gulp.watch('build/js/*.js', gulp.parallel('build-shopify_billing', 'build-shopify_analytics'));
  gulp.watch('build/css/*.css', gulp.parallel('build-shopify_billing_styles', 'build-shopify_admin_styles'));
});

gulp.task('default',
  gulp.parallel(
    'build-shopify_billing',
    'build-shopify_analytics',
    'build-shopify_billing_styles',
    'build-shopify_admin_styles',
    'copy-app-bridge',
    'watch'
  )
);
