cmake_minimum_required(VERSION 3.20)
project(mirrorgate_cpp_sdk VERSION 0.1.0 LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)
find_package(Threads REQUIRED)

if(NOT TARGET nlohmann_json::nlohmann_json)
  find_package(nlohmann_json 3.11.3 EXACT QUIET CONFIG)
endif()
if(NOT TARGET nlohmann_json::nlohmann_json)
  set(MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR "" CACHE PATH
      "Directory containing nlohmann/json.hpp from nlohmann_json 3.11.3")
  if(NOT EXISTS "${MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR}/nlohmann/json.hpp")
    message(FATAL_ERROR
      "MirrorGate C++ requires nlohmann_json exactly 3.11.3. Install its CMake package "
      "or set MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR; no network fetch is performed.")
  endif()
  add_library(mirrorgate_nlohmann_json INTERFACE)
  target_include_directories(mirrorgate_nlohmann_json SYSTEM INTERFACE
    "${MIRRORGATE_NLOHMANN_JSON_INCLUDE_DIR}")
  add_library(nlohmann_json::nlohmann_json ALIAS mirrorgate_nlohmann_json)
endif()

add_library(mirrorgate_cpp
  src/json.cpp
  src/transport.cpp
  src/control.cpp
  src/control_v2.cpp
  src/managed_worker.cpp)
add_library(mirrorgate::cpp ALIAS mirrorgate_cpp)
target_include_directories(mirrorgate_cpp PUBLIC
  "$<BUILD_INTERFACE:${CMAKE_CURRENT_SOURCE_DIR}/include>")
target_link_libraries(mirrorgate_cpp PUBLIC nlohmann_json::nlohmann_json Threads::Threads)
target_compile_definitions(mirrorgate_cpp PUBLIC
  NLOHMANN_JSON_VERSION_MAJOR_EXPECTED=3
  NLOHMANN_JSON_VERSION_MINOR_EXPECTED=11
  NLOHMANN_JSON_VERSION_PATCH_EXPECTED=3)
target_compile_options(mirrorgate_cpp PRIVATE -Wall -Wextra -Wpedantic -Werror)

include(CTest)
if(BUILD_TESTING)
  add_executable(mirrorgate_cpp_tests ../../tests/cpp/sdk_test.cpp)
  target_link_libraries(mirrorgate_cpp_tests PRIVATE mirrorgate::cpp)
  target_compile_options(mirrorgate_cpp_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME mirrorgate_cpp_tests COMMAND mirrorgate_cpp_tests
    "${CMAKE_CURRENT_SOURCE_DIR}/../../conformance/vectors.jsonl"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../conformance/control-v1/vectors.jsonl"
    "${CMAKE_CURRENT_SOURCE_DIR}/../../conformance/manifests/counter.json")
  add_executable(mirrorgate_control_e2e ../../tests/cpp/control_e2e.cpp)
  target_link_libraries(mirrorgate_control_e2e PRIVATE mirrorgate::cpp)
  target_compile_options(mirrorgate_control_e2e PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_executable(mirrorgate_transport_tests ../../tests/cpp/transport_test.cpp)
  target_link_libraries(mirrorgate_transport_tests PRIVATE mirrorgate::cpp)
  target_compile_options(mirrorgate_transport_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME mirrorgate_transport_tests COMMAND mirrorgate_transport_tests)
endif()

if(BUILD_TESTING)
  add_executable(mirrorgate_hosting_tests ../../tests/cpp/hosting_test.cpp)
  target_link_libraries(mirrorgate_hosting_tests PRIVATE mirrorgate::cpp)
  target_compile_options(mirrorgate_hosting_tests PRIVATE -Wall -Wextra -Wpedantic -Werror)
  add_test(NAME mirrorgate_hosting_tests COMMAND mirrorgate_hosting_tests
    "${CMAKE_CURRENT_SOURCE_DIR}/../../conformance/control-v2/vectors.jsonl")
endif()
if(BUILD_TESTING)
  add_executable(mirrorgate_hosting_e2e ../../tests/cpp/hosting_e2e.cpp)
  target_link_libraries(mirrorgate_hosting_e2e PRIVATE mirrorgate::cpp)
  target_compile_options(mirrorgate_hosting_e2e PRIVATE -Wall -Wextra -Wpedantic -Werror)
endif()
