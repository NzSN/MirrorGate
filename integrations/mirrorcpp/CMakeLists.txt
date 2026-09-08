cmake_minimum_required(VERSION 3.24)
project(mirrorgate_mirrorcpp_integration LANGUAGES CXX)

set(MIRRORCPP_ROOT "" CACHE PATH "Prepared MirrorCPP checkout")
if(NOT EXISTS "${MIRRORCPP_ROOT}/include/mirrorcpp/client.hpp")
  message(FATAL_ERROR "MIRRORCPP_ROOT must name a prepared MirrorCPP checkout")
endif()

set(MIRRORCPP_DEPENDENCY_CACHE "" CACHE PATH
    "MirrorCPP FetchContent source cache (normally MIRRORCPP_ROOT/build/_deps)")
if(MIRRORCPP_DEPENDENCY_CACHE)
  set(_mirrorcpp_cached_dependencies
    nlohmann_json boost_multiprecision boost_config boost_core boost_assert
    boost_static_assert boost_throw_exception boost_exception boost_type_traits
    boost_utility boost_integer boost_mpl boost_preprocessor boost_predef
    boost_rational boost_smart_ptr boost_tuple boost_io boost_winapi)
  foreach(_dependency IN LISTS _mirrorcpp_cached_dependencies)
    string(TOUPPER "${_dependency}" _dependency_upper)
    set(_source "${MIRRORCPP_DEPENDENCY_CACHE}/${_dependency}-src")
    if(NOT EXISTS "${_source}")
      message(FATAL_ERROR "missing cached MirrorCPP dependency source: ${_source}")
    endif()
    set("FETCHCONTENT_SOURCE_DIR_${_dependency_upper}" "${_source}" CACHE PATH "" FORCE)
  endforeach()
endif()

set(MIRRORCPP_WITH_TLS OFF CACHE BOOL "" FORCE)
set(MIRRORCPP_BUILD_TESTS OFF CACHE BOOL "" FORCE)
set(MIRRORCPP_BUILD_EXAMPLES OFF CACHE BOOL "" FORCE)
set(MIRRORCPP_BUILD_CLI OFF CACHE BOOL "" FORCE)
add_subdirectory("${MIRRORCPP_ROOT}" mirrorcpp-build EXCLUDE_FROM_ALL)
add_subdirectory("${CMAKE_CURRENT_LIST_DIR}/../../sdk/cpp" mirrorgate-sdk-build
                 EXCLUDE_FROM_ALL)

add_library(mirrorgate_mirrorcpp_orchestration orchestration.cpp)
target_include_directories(mirrorgate_mirrorcpp_orchestration PUBLIC
  "${CMAKE_CURRENT_LIST_DIR}")
target_link_libraries(mirrorgate_mirrorcpp_orchestration PUBLIC
  mirrorgate::cpp mirrorcpp::mirrorcpp)
target_compile_features(mirrorgate_mirrorcpp_orchestration PUBLIC cxx_std_23)
target_compile_options(mirrorgate_mirrorcpp_orchestration PRIVATE
  -Wall -Wextra -Wpedantic -Werror)

add_executable(mirrorgate_mirrorcpp_counter counter_driver.cpp)
target_include_directories(mirrorgate_mirrorcpp_counter PRIVATE
  "${MIRRORCPP_ROOT}/test/fixtures/model-interface/counter/generated")
target_link_libraries(mirrorgate_mirrorcpp_counter PRIVATE
  mirrorgate_mirrorcpp_orchestration)
target_compile_features(mirrorgate_mirrorcpp_counter PRIVATE cxx_std_23)
target_compile_options(mirrorgate_mirrorcpp_counter PRIVATE
  -Wall -Wextra -Wpedantic -Werror)

add_executable(mirrorgate_mirrorcpp_receipt_tests
  "${CMAKE_CURRENT_LIST_DIR}/../../tests/cpp/orchestration_receipt_test.cpp")
target_link_libraries(mirrorgate_mirrorcpp_receipt_tests PRIVATE
  mirrorgate_mirrorcpp_orchestration)
target_compile_features(mirrorgate_mirrorcpp_receipt_tests PRIVATE cxx_std_23)
target_compile_options(mirrorgate_mirrorcpp_receipt_tests PRIVATE
  -Wall -Wextra -Wpedantic -Werror)
