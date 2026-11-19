<template>
  <a-config-provider :theme="theme">
    <HelloWorld />
  </a-config-provider>
</template>

<script>
import HelloWorld from './components/HelloWorld.vue'

export default {
  name: 'App',
  components: {
    HelloWorld
  },
  data() {
    return {
      theme: {
        token: {
          colorPrimary: '#2e6be6',
          borderRadius: 8,
          fontSize: 13,
        },
      },
    }
  },
}
</script>

<style>
#app {
  font-family: "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic UI", "Yu Gothic", "Noto Sans JP", Meiryo, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
  color: #1f2329;
}
</style>
