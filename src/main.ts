import { createApp } from 'vue'
import App from './App.vue'
import './styles/global.css'
import { store } from './state/store'
import { controller } from './engine/controller'

const app = createApp(App)
app.mount('#app')

/**
 * Small inspection hook for debugging and end-to-end tests: everything the app
 * knows is reachable from the console without touching module internals.
 * (No secrets are involved — tokens live in `store.loadOptions.tokens`.)
 */
declare global {
  interface Window {
    webGource?: { store: typeof store; controller: typeof controller; version: string }
  }
}

window.webGource = {
  store,
  controller,
  version: '1.0.0',
}
